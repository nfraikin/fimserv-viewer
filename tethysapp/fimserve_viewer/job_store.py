"""Database-backed persistence for background flood-map jobs.

All reads and writes go through the app persistent store so every portal
replica sees the same job records. Methods return plain dicts, never live
ORM objects.
"""

from contextlib import contextmanager
from datetime import timedelta
from typing import Optional, Tuple

from sqlalchemy.exc import IntegrityError

from .model import Job, JobStatus, utcnow


def app_session_maker():
    """Session factory bound to the app's ``jobs_db`` persistent store."""
    from .app import App

    return App.get_persistent_store_database("jobs_db", as_sessionmaker=True)


class JobStore:
    """Reads and writes job records in the ``jobs_db`` persistent store."""

    def __init__(self, session_maker=None):
        self.session_maker = session_maker or app_session_maker()

    @contextmanager
    def session(self):
        """Yield a session that commits on success and rolls back on error."""
        session = self.session_maker()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def create_or_get_active(self, kind: str, huc8: str, key: str, params: dict, owner: str) -> Tuple[dict, bool]:
        """Insert a queued job owned by this replica, or return the active duplicate.

        The partial unique index on active keys makes this race-safe across
        replicas: the losing inserter adopts the winner's job.
        """
        try:
            with self.session() as session:
                job = Job(key=key, kind=kind, huc8=huc8, params=params, claimed_by=owner)
                session.add(job)
                session.flush()
                return job.to_dict(), True
        except IntegrityError:
            existing = self.find_active(key)
            if existing is None:
                raise
            return existing, False

    def claim(self, job_id: str, worker: str) -> bool:
        """Confirm a queued job is still this worker's to run; False otherwise."""
        with self.session() as session:
            claimed = (
                session.query(Job)
                .filter(Job.id == job_id, Job.status == JobStatus.QUEUED, Job.claimed_by == worker)
                .update({"heartbeat_at": utcnow(), "updated_at": utcnow()})
            )
            return claimed == 1

    def update_progress(self, job_id: str, status: str, message: str = "") -> None:
        """Record a status transition reported by the running pipeline."""
        self.update_fields(job_id, status=status, message=message, heartbeat_at=utcnow())

    def finish(
        self, job_id: str, status: str, message: str, result_file: str = "", error_detail: str = ""
    ) -> None:
        """Record the terminal state of a job.

        ``message`` is the short text shown in the UI; ``error_detail`` holds
        the full traceback of a failed job for operators.
        """
        self.update_fields(
            job_id, status=status, message=message, result_file=result_file, error_detail=error_detail
        )

    def get_error_detail(self, job_id: str) -> Optional[str]:
        """Return a job's stored traceback ("" if none), or None if the job doesn't exist."""
        with self.session() as session:
            job = session.get(Job, job_id)
            return job.error_detail if job else None

    def touch_owned(self, owner: str) -> None:
        """Refresh the heartbeat of every active job owned by this replica."""
        with self.session() as session:
            session.query(Job).filter(
                Job.status.in_(JobStatus.ACTIVE), Job.claimed_by == owner
            ).update({"heartbeat_at": utcnow()}, synchronize_session=False)

    def update_fields(self, job_id: str, **fields) -> None:
        """Apply column updates to one job, stamping ``updated_at``."""
        fields["updated_at"] = utcnow()
        with self.session() as session:
            session.query(Job).filter(Job.id == job_id).update(fields)

    def get(self, job_id: str) -> Optional[dict]:
        """Return one job as a dict, or None."""
        with self.session() as session:
            job = session.get(Job, job_id)
            return job.to_dict() if job else None

    def find_active(self, key: str) -> Optional[dict]:
        """Return the active job with the given key, or None."""
        return self.first_active_dict(Job.key == key)

    def active_huc8s(self) -> set:
        """Return the HUC8s that have an active job, in any replica.

        Hydrofabric eviction reads this to know which HUCs it must not
        delete out from under a running job (issue #6). Callers sweep stale
        jobs first, so a replica that died mid-job does not pin its HUC.
        """
        with self.session() as session:
            rows = (
                session.query(Job.huc8)
                .filter(Job.status.in_(JobStatus.ACTIVE))
                .distinct()
            )
            return {huc8 for (huc8,) in rows}

    def find_active_for_huc(self, huc8: str) -> Optional[dict]:
        """Return the active job for a HUC8, or None."""
        return self.first_active_dict(Job.huc8 == huc8)

    def first_active_dict(self, *criteria) -> Optional[dict]:
        """Return the first active job matching the criteria, or None."""
        with self.session() as session:
            job = (
                session.query(Job)
                .filter(Job.status.in_(JobStatus.ACTIVE), *criteria)
                .order_by(Job.created_at)
                .first()
            )
            return job.to_dict() if job else None

    def mark_stale_interrupted(self, timeout_seconds: int = 180) -> None:
        """Mark active jobs with a stale heartbeat as interrupted.

        Catches jobs whose replica died; any surviving replica can sweep.
        """
        cutoff = utcnow() - timedelta(seconds=timeout_seconds)
        with self.session() as session:
            session.query(Job).filter(
                Job.status.in_(JobStatus.ACTIVE), Job.heartbeat_at < cutoff
            ).update(
                {
                    "status": JobStatus.INTERRUPTED,
                    "message": "The portal restarted while this job was running.",
                    "updated_at": utcnow(),
                },
                synchronize_session=False,
            )

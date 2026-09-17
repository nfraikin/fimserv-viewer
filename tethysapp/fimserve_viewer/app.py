from tethys_sdk.app_settings import PersistentStoreDatabaseSetting
from tethys_sdk.base import TethysAppBase


class App(TethysAppBase):
    """Tethys app class for the FIMserve Viewer."""

    name = 'FIMserve Viewer'
    description = 'HUC8 flood inundation viewer powered by FIMserv.'
    package = 'fimserve_viewer'  # WARNING: Do not change this value
    index = 'home'
    icon = f'{package}/images/fimserv.png'
    root_url = 'fimserve-viewer'
    color = '#1e88e5'
    tags = '"Hydrology","Hydroinformatics","Flood","FIMserv"'
    enable_feedback = False
    feedback_emails = []
    controller_modules = ['job_controllers']

    def persistent_store_settings(self):
        """Declare the database that stores background job records."""
        return (
            PersistentStoreDatabaseSetting(
                name='jobs_db',
                description='Background flood-map job records shared across portal replicas. '
                            'Assign a sqlite-type service for development.',
                initializer='fimserve_viewer.model.init_jobs_db',
                required=True,
            ),
        )

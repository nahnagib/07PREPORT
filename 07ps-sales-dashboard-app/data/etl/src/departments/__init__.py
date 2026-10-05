"""Department marts. Each department is a sub-package with a ``jobs.py`` that registers its datasets, tasks
and jobs with ``etl_platform.registry.REGISTRY``; ``load_definitions()`` discovers it automatically.
See docs/adding-a-department.md and ``departments/_template``.
"""

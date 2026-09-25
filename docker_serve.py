"""Production entrypoint for containers.

run.py's terminal dashboard needs an interactive TTY and isn't meant for this;
this just serves the app over Waitress, matching the other deployed apps.
"""

import os

from waitress import serve

from server import create_app

if __name__ == "__main__":
    serve(
        create_app(),
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "5051")),
    )

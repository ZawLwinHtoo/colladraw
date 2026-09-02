# Nginx gateway

In the Docker demo, Nginx serves the frontend files and forwards `/ws/` and `/health` to either FastAPI backend. The WebSocket upgrade headers are required so a browser connection stays open after proxying.

Run the complete stack from the repository root with `docker compose up --build`, then open http://localhost:8090.

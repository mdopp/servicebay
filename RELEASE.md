# Release Process

This project uses a GitHub Actions workflow (`.github/workflows/release.yml`) to automate the release process.

**DO NOT manually create releases or tags.**

## How to Release

1.  **Update Version:**
    Bump the version in `package.json`.
    ```bash
    npm version patch  # or minor, major
    ```

2.  **Push Changes:**
    Push the commit and the tag to GitHub.
    ```bash
    git push && git push --tags
    ```

3.  **Wait for Action:**
    The GitHub Action will automatically:
    - Build the Docker image.
    - Push the image to GitHub Container Registry (`ghcr.io/mdopp/servicebay`).
    - Create a GitHub Release with `install.sh`.

## Artifacts Explained

-   `install.sh`: The installer script that sets up the ServiceBay container using Podman Quadlet.
-   **Docker Image**: Hosted on GHCR (`ghcr.io/mdopp/servicebay:latest` and version tags).

## Troubleshooting

If a release fails, check the "Actions" tab in the GitHub repository.

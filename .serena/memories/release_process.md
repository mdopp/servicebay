# Release Process

## Creating a Release
1.  **Tag**: Create a new git tag (e.g., `v1.0.0`).
2.  **Push**: Push the tag to GitHub (`git push origin v1.0.0`).
3.  **CI/CD**: The GitHub Action `.github/workflows/release.yml` will automatically:
    *   Build the Next.js application.
    *   Compile the custom server.
    *   Bundle everything (including `node_modules`) into `servicebay-linux-x64.tar.gz`.
    *   Create a GitHub Release and attach the tarball.

## Installation
The `install.sh` script is configured to download the **latest release** artifact.
It does **not** build the application on the client machine anymore, which makes installation much faster and removes the need for `npm` (only `node` runtime is required).

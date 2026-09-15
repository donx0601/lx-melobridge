# Security

## Reporting a vulnerability

Please do not publish credentials, source-script secrets, or a working exploit in a public issue.
Use GitHub private vulnerability reporting when it is enabled for the repository.

## Deployment boundary

- Expose the gateway only through HTTPS.
- Do not expose the source-script administration port to the public internet.
- Use different long random values for gateway, administration, and resolver credentials.
- Treat every third-party source script as executable code and review it before loading.
- Keep `.env`, `data`, `runner-data`, custom provider files, and third-party source scripts out of Git.

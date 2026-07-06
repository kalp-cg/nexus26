# Security Policy

## Supported Version

This hackathon submission is maintained from the `main` branch during the event window.

## Reporting

Please report security issues privately to the project maintainer. Do not open public issues for exploitable behavior.

## Current Controls

- Strict JSON body size limits for API requests.
- Whitelist-only file access for the JSON/Markdown data layer.
- Output escaping for user-provided strings before storage and broadcast.
- CORS restricted to the deployment origin and local development hosts.
- Security headers for clickjacking, MIME sniffing, referrer policy, permissions policy, and CSP.
- Request rate limiting to reduce brute-force and denial-of-service pressure.

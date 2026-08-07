# Optional manual Render deployment for EasyProxy.
# Create it as a separate Web Service and set API_PASSWORD in Render's dashboard.
FROM ghcr.io/realbestia1/easyproxy:latest

ENV PORT=10000
EXPOSE 10000

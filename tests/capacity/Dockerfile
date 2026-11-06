# Capacity-test image (F13b): the production gateway image plus the compiled
# synthetic harness and its synthetic configuration. Never deployed.
ARG GATEWAY_IMAGE
FROM ${GATEWAY_IMAGE}
COPY dist-capacity /app/dist-capacity
COPY migrations /app/dist-capacity/migrations
COPY gateway.json /app/capacity/gateway.json
USER 1000:1000
ENV GATEWAY_CONFIG_PATH=/app/capacity/gateway.json
CMD ["node", "dist-capacity/tests/capacity/gateway-under-test.js"]

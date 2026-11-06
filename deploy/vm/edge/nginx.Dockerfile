# The ingress image (VM design sections 2 and 4): the pinned upstream
# unprivileged nginx (uid 101), with Alpine's security updates applied at
# build time, as the gateway image applies Debian's, so the CI scan of fixable
# HIGH and CRITICAL findings passes. CI builds and scans it; the deploy
# workflow builds it for linux/amd64 and pushes it by digest.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
USER root
RUN apk upgrade --no-cache
USER 101

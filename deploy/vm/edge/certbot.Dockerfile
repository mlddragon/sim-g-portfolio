# The certificate client (VM design section 3): the pinned upstream certbot,
# with Alpine's and its Python libraries' security updates applied at build
# time. pip and uv are removed: certbot never installs anything at run time,
# and their vendored libraries carried fixable findings. It runs as uid 101.
# CI builds and scans it; the deploy workflow builds and pushes it by digest.
FROM certbot/certbot:v5.8.0@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20
RUN apk upgrade --no-cache \
  && pip install --no-cache-dir --upgrade 'certifi>=2026.10.18' 'urllib3>=2.8.0' 'msgpack>=1.2.3' >/dev/null \
  && pip uninstall --yes uv >/dev/null \
  && python -m pip uninstall --yes pip >/dev/null \
  && rm -f /usr/local/bin/uv /usr/local/bin/uvx
# certbot always runs as uid 101 (sim-g-certificate.sh), so nginx can read its key.
USER 101:101

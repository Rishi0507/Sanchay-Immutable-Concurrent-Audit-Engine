# Build context: the repository root.
FROM ocaml/opam:debian-12-ocaml-5.2 AS build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev pkg-config libgmp-dev \
    && rm -rf /var/lib/apt/lists/*
USER opam
WORKDIR /home/opam/src
RUN opam install -y dune yojson digestif eio_main cohttp-eio postgresql
COPY --chown=opam:opam ledger/ ./ledger/
WORKDIR /home/opam/src/ledger
RUN opam exec -- dune build --profile release ./bin/main.exe \
    && opam exec -- dune test --profile release

FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /home/opam/src/ledger/_build/default/bin/main.exe /usr/local/bin/ledger
COPY contracts/ /app/contracts/
ENV CATALOGUE_PATH=/app/contracts/events.json \
    LEDGER_PORT=7001
EXPOSE 7001
USER nobody
ENTRYPOINT ["/usr/local/bin/ledger"]

- **The terminal image stops shipping webpack's build cache, and says which variant it is.**
  `.next/cache` is webpack's incremental-compile cache and no part of the running app, and it was
  paid on every build and every pull: the image's `.next` layer measured 199 MB, of which 6.89 MB was
  the app. It is now deleted in the same layer that creates it, so the builder never materialises it
  either — the whole image goes 1084 MB -> 908 MB uncompressed. The image also carries
  `ai.vexa.terminal.mode` as a label: every terminal variant comes out of one Dockerfile and differs
  only by a build arg, so nothing in the bytes said which surface they were — a label survives
  `docker save`/`load` and a registry round-trip, is readable without starting the container, and
  cannot be shadowed at `docker run -e` time.

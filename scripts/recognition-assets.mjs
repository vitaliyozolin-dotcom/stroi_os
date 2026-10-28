import { createReadStream } from "node:fs";
import { mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
export const recognitionAssetPrefix = "/recognition-assets/v1/";
export async function recognitionAssetFiles(root) {
  const modules = resolve(root, "node_modules"),
    files = new Map();
  const add = (name, path) => files.set(name, path);
  add("worker.min.js", join(modules, "tesseract.js/dist/worker.min.js"));
  for (const name of await readdir(join(modules, "tesseract.js-core")))
    if (/\.wasm(?:\.js)?$/.test(name))
      add(`core/${name}`, join(modules, "tesseract.js-core", name));
  for (const lang of ["rus", "eng"])
    add(
      `lang/${lang}.traineddata.gz`,
      join(
        modules,
        `@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
      ),
    );
  add(
    "pdf.worker.min.mjs",
    join(modules, "pdfjs-dist/build/pdf.worker.min.mjs"),
  );
  for (const directory of ["wasm", "standard_fonts", "cmaps"])
    for (const name of await readdir(join(modules, "pdfjs-dist", directory)))
      add(
        `pdf/${directory}/${name}`,
        join(modules, "pdfjs-dist", directory, name),
      );
  return files;
}
export function recognitionAssetsPlugin() {
  let root, output, files;
  const mime = (path) =>
    path.endsWith(".mjs") || path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".wasm")
        ? "application/wasm"
        : "application/octet-stream";
  return {
    name: "local-document-recognition-assets",
    async configResolved(config) {
      root = config.root;
      output = resolve(root, config.build.outDir);
      files = await recognitionAssetFiles(root);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        if (!pathname.startsWith(recognitionAssetPrefix)) return next();
        const file = files.get(pathname.slice(recognitionAssetPrefix.length));
        if (!file) {
          response.statusCode = 404;
          response.end("Not found");
          return;
        }
        response.setHeader("Content-Type", mime(file));
        response.setHeader("Cache-Control", "public,max-age=3600");
        const stream = createReadStream(file);
        stream.on("error", () => {
          response.statusCode = 500;
          response.end("Asset unavailable");
        });
        stream.pipe(response);
      });
    },
    async closeBundle() {
      for (const [name, file] of files) {
        const destination = join(output, recognitionAssetPrefix.slice(1), name);
        await mkdir(resolve(destination, ".."), { recursive: true });
        await copyFile(file, destination);
      }
    },
  };
}

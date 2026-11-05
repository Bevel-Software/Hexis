/**
 * Ambient declaration for Vite's `?url` asset imports (`import workerUrl from
 * 'pdfjs-dist/build/pdf.worker.min.mjs?url'`). The enterprise app gets this
 * from Vite's `vite/client` types; this package is published as raw source and
 * typechecked without Vite, so it declares the module shape itself (harmless
 * alongside vite/client in consumers — same arrangement as the CSS
 * side-effect declaration next door).
 */
declare module '*?url' {
  const url: string;
  export default url;
}

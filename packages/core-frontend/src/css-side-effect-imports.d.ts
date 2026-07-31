/**
 * Ambient declaration for side-effect CSS imports (`import '../library.css'`).
 * The enterprise app gets this from Vite's `vite/client` types; this package
 * is published as raw source and typechecked without Vite, so it declares the
 * module shape itself (harmless alongside vite/client in consumers).
 */
declare module '*.css';

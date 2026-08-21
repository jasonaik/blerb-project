/**
 * Library entry — the import pipeline, callable without the CLI.
 *
 * The desktop app's GUI importer and the batch scripts go through these; the
 * CLI in cli.ts is a thin argument parser over the same functions. `preview`
 * is deliberately NOT exported here: it pulls in vite, which nothing embedding
 * the importers should have to carry.
 */

export { fromGif, type FromGifOptions } from './commands/fromGif.js';
export { fromImage, type FromImageOptions } from './commands/fromImage.js';
export { fromSheet, type FromSheetOptions } from './commands/fromSheet.js';
export { fromFrames, type FromFramesOptions } from './commands/fromFrames.js';
export { doctor, diagnosePack, type Diagnosis, type Finding } from './commands/doctor.js';
export { slugFromFilename } from './import/spec.js';
export { countFrames } from './import/io.js';

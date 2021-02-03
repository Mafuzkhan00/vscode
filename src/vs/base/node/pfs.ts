/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'vs/base/common/path';
import { Queue } from 'vs/base/common/async';
import { isMacintosh, isWindows } from 'vs/base/common/platform';
import { Event } from 'vs/base/common/event';
import { promisify } from 'util';
import { isRootOrDriveLetter } from 'vs/base/common/extpath';
import { generateUuid } from 'vs/base/common/uuid';
import { normalizeNFC } from 'vs/base/common/normalization';

//#region Constants

// See https://github.com/microsoft/vscode/issues/30180
const WIN32_MAX_FILE_SIZE = 300 * 1024 * 1024; // 300 MB
const GENERAL_MAX_FILE_SIZE = 16 * 1024 * 1024 * 1024; // 16 GB

// See https://github.com/v8/v8/blob/5918a23a3d571b9625e5cce246bdd5b46ff7cd8b/src/heap/heap.cc#L149
const WIN32_MAX_HEAP_SIZE = 700 * 1024 * 1024; // 700 MB
const GENERAL_MAX_HEAP_SIZE = 700 * 2 * 1024 * 1024; // 1400 MB

export const MAX_FILE_SIZE = process.arch === 'ia32' ? WIN32_MAX_FILE_SIZE : GENERAL_MAX_FILE_SIZE;
export const MAX_HEAP_SIZE = process.arch === 'ia32' ? WIN32_MAX_HEAP_SIZE : GENERAL_MAX_HEAP_SIZE;

//#endregion

//#region rimraf

export enum RimRafMode {

	/**
	 * Slow version that unlinks each file and folder.
	 */
	UNLINK,

	/**
	 * Fast version that first moves the file/folder
	 * into a temp directory and then deletes that
	 * without waiting for it.
	 */
	MOVE
}

export async function rimraf(path: string, mode = RimRafMode.UNLINK): Promise<void> {
	if (isRootOrDriveLetter(path)) {
		throw new Error('rimraf - will refuse to recursively delete root');
	}

	// delete: via rmDir
	if (mode === RimRafMode.UNLINK) {
		return rimrafUnlink(path);
	}

	// delete: via move
	return rimrafMove(path);
}

async function rimrafMove(path: string): Promise<void> {
	try {
		const pathInTemp = join(tmpdir(), generateUuid());
		try {
			await fs.promises.rename(path, pathInTemp);
		} catch (error) {
			return rimrafUnlink(path); // if rename fails, delete without tmp dir
		}

		// Delete but do not return as promise
		rimrafUnlink(pathInTemp).catch(error => {/* ignore */ });
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}
}

async function rimrafUnlink(path: string): Promise<void> {
	return fs.promises.rmdir(path, { recursive: true, maxRetries: 3 });
}

export function rimrafSync(path: string): void {
	if (isRootOrDriveLetter(path)) {
		throw new Error('rimraf - will refuse to recursively delete root');
	}

	fs.rmdirSync(path, { recursive: true });
}

//#endregion

//#region readdir with NFC support (macos)

export async function readdir(path: string): Promise<string[]> {
	return handleDirectoryChildren(await promisify(fs.readdir)(path));
}

export async function readdirWithFileTypes(path: string): Promise<fs.Dirent[]> {
	const children = await promisify(fs.readdir)(path, { withFileTypes: true });

	// Mac: uses NFD unicode form on disk, but we want NFC
	// See also https://github.com/nodejs/node/issues/2165
	if (isMacintosh) {
		for (const child of children) {
			child.name = normalizeNFC(child.name);
		}
	}

	return children;
}

export function readdirSync(path: string): string[] {
	return handleDirectoryChildren(fs.readdirSync(path));
}

function handleDirectoryChildren(children: string[]): string[] {
	// Mac: uses NFD unicode form on disk, but we want NFC
	// See also https://github.com/nodejs/node/issues/2165
	if (isMacintosh) {
		return children.map(child => normalizeNFC(child));
	}

	return children;
}

export async function readDirsInDir(dirPath: string): Promise<string[]> {
	const children = await readdir(dirPath);
	const directories: string[] = [];

	for (const child of children) {
		if (await SymlinkSupport.dirExists(join(dirPath, child))) {
			directories.push(child);
		}
	}

	return directories;
}

//#endregion

//#region whenDeleted()

export function whenDeleted(path: string): Promise<void> {

	// Complete when wait marker file is deleted
	return new Promise<void>(resolve => {
		let running = false;
		const interval = setInterval(() => {
			if (!running) {
				running = true;
				fs.access(path, err => {
					running = false;

					if (err) {
						clearInterval(interval);
						resolve(undefined);
					}
				});
			}
		}, 1000);
	});
}

//#endregion

//#region Methods with symbolic links support

export namespace SymlinkSupport {

	export interface IStats {

		// The stats of the file. If the file is a symbolic
		// link, the stats will be of that target file and
		// not the link itself.
		// If the file is a symbolic link pointing to a non
		// existing file, the stat will be of the link and
		// the `dangling` flag will indicate this.
		stat: fs.Stats;

		// Will be provided if the resource is a symbolic link
		// on disk. Use the `dangling` flag to find out if it
		// points to a resource that does not exist on disk.
		symbolicLink?: { dangling: boolean };
	}

	/**
	 * Resolves the `fs.Stats` of the provided path. If the path is a
	 * symbolic link, the `fs.Stats` will be from the target it points
	 * to. If the target does not exist, `dangling: true` will be returned
	 * as `symbolicLink` value.
	 */
	export async function stat(path: string): Promise<IStats> {

		// First stat the link
		let lstats: fs.Stats | undefined;
		try {
			lstats = await fs.promises.lstat(path);

			// Return early if the stat is not a symbolic link at all
			if (!lstats.isSymbolicLink()) {
				return { stat: lstats };
			}
		} catch (error) {
			/* ignore - use stat() instead */
		}

		// If the stat is a symbolic link or failed to stat, use fs.stat()
		// which for symbolic links will stat the target they point to
		try {
			const stats = await fs.promises.stat(path);

			return { stat: stats, symbolicLink: lstats?.isSymbolicLink() ? { dangling: false } : undefined };
		} catch (error) {

			// If the link points to a non-existing file we still want
			// to return it as result while setting dangling: true flag
			if (error.code === 'ENOENT' && lstats) {
				return { stat: lstats, symbolicLink: { dangling: true } };
			}

			// Windows: workaround a node.js bug where reparse points
			// are not supported (https://github.com/nodejs/node/issues/36790)
			if (isWindows && error.code === 'EACCES' && lstats) {
				try {
					const stats = await fs.promises.stat(await fs.promises.readlink(path));

					return { stat: stats, symbolicLink: lstats.isSymbolicLink() ? { dangling: false } : undefined };
				} catch (error) {

					// If the link points to a non-existing file we still want
					// to return it as result while setting dangling: true flag
					if (error.code === 'ENOENT') {
						return { stat: lstats, symbolicLink: { dangling: true } };
					}

					throw error;
				}
			}

			throw error;
		}
	}

	export async function fileExists(path: string): Promise<boolean> {
		try {
			const { stat, symbolicLink } = await SymlinkSupport.stat(path);

			return stat.isFile() && symbolicLink?.dangling !== true;
		} catch (error) {
			// Ignore, path might not exist
		}

		return false;
	}

	export async function dirExists(path: string): Promise<boolean> {
		try {
			const { stat, symbolicLink } = await SymlinkSupport.stat(path);

			return stat.isDirectory() && symbolicLink?.dangling !== true;
		} catch (error) {
			// Ignore, path might not exist
		}

		return false;
	}
}

//#endregion

//#region Write File

// According to node.js docs (https://nodejs.org/docs/v6.5.0/api/fs.html#fs_fs_writefile_file_data_options_callback)
// it is not safe to call writeFile() on the same path multiple times without waiting for the callback to return.
// Therefor we use a Queue on the path that is given to us to sequentialize calls to the same path properly.
const writeFilePathQueues: Map<string, Queue<void>> = new Map();

export function writeFile(path: string, data: string, options?: IWriteFileOptions): Promise<void>;
export function writeFile(path: string, data: Buffer, options?: IWriteFileOptions): Promise<void>;
export function writeFile(path: string, data: Uint8Array, options?: IWriteFileOptions): Promise<void>;
export function writeFile(path: string, data: string | Buffer | Uint8Array, options?: IWriteFileOptions): Promise<void>;
export function writeFile(path: string, data: string | Buffer | Uint8Array, options?: IWriteFileOptions): Promise<void> {
	const queueKey = toQueueKey(path);

	return ensureWriteFileQueue(queueKey).queue(() => {
		const ensuredOptions = ensureWriteOptions(options);

		return new Promise((resolve, reject) => doWriteFileAndFlush(path, data, ensuredOptions, error => error ? reject(error) : resolve()));
	});
}

function toQueueKey(path: string): string {
	let queueKey = path;
	if (isWindows || isMacintosh) {
		queueKey = queueKey.toLowerCase(); // accommodate for case insensitive file systems
	}

	return queueKey;
}

function ensureWriteFileQueue(queueKey: string): Queue<void> {
	const existingWriteFileQueue = writeFilePathQueues.get(queueKey);
	if (existingWriteFileQueue) {
		return existingWriteFileQueue;
	}

	const writeFileQueue = new Queue<void>();
	writeFilePathQueues.set(queueKey, writeFileQueue);

	const onFinish = Event.once(writeFileQueue.onFinished);
	onFinish(() => {
		writeFilePathQueues.delete(queueKey);
		writeFileQueue.dispose();
	});

	return writeFileQueue;
}

export interface IWriteFileOptions {
	mode?: number;
	flag?: string;
}

interface IEnsuredWriteFileOptions extends IWriteFileOptions {
	mode: number;
	flag: string;
}

let canFlush = true;

// Calls fs.writeFile() followed by a fs.sync() call to flush the changes to disk
// We do this in cases where we want to make sure the data is really on disk and
// not in some cache.
//
// See https://github.com/nodejs/node/blob/v5.10.0/lib/fs.js#L1194
function doWriteFileAndFlush(path: string, data: string | Buffer | Uint8Array, options: IEnsuredWriteFileOptions, callback: (error: Error | null) => void): void {
	if (!canFlush) {
		return fs.writeFile(path, data, { mode: options.mode, flag: options.flag }, callback);
	}

	// Open the file with same flags and mode as fs.writeFile()
	fs.open(path, options.flag, options.mode, (openError, fd) => {
		if (openError) {
			return callback(openError);
		}

		// It is valid to pass a fd handle to fs.writeFile() and this will keep the handle open!
		fs.writeFile(fd, data, writeError => {
			if (writeError) {
				return fs.close(fd, () => callback(writeError)); // still need to close the handle on error!
			}

			// Flush contents (not metadata) of the file to disk
			fs.fdatasync(fd, (syncError: Error | null) => {

				// In some exotic setups it is well possible that node fails to sync
				// In that case we disable flushing and warn to the console
				if (syncError) {
					console.warn('[node.js fs] fdatasync is now disabled for this session because it failed: ', syncError);
					canFlush = false;
				}

				return fs.close(fd, closeError => callback(closeError));
			});
		});
	});
}

export function writeFileSync(path: string, data: string | Buffer, options?: IWriteFileOptions): void {
	const ensuredOptions = ensureWriteOptions(options);

	if (!canFlush) {
		return fs.writeFileSync(path, data, { mode: ensuredOptions.mode, flag: ensuredOptions.flag });
	}

	// Open the file with same flags and mode as fs.writeFile()
	const fd = fs.openSync(path, ensuredOptions.flag, ensuredOptions.mode);

	try {

		// It is valid to pass a fd handle to fs.writeFile() and this will keep the handle open!
		fs.writeFileSync(fd, data);

		// Flush contents (not metadata) of the file to disk
		try {
			fs.fdatasyncSync(fd);
		} catch (syncError) {
			console.warn('[node.js fs] fdatasyncSync is now disabled for this session because it failed: ', syncError);
			canFlush = false;
		}
	} finally {
		fs.closeSync(fd);
	}
}

function ensureWriteOptions(options?: IWriteFileOptions): IEnsuredWriteFileOptions {
	if (!options) {
		return { mode: 0o666 /* default node.js mode for files */, flag: 'w' };
	}

	return {
		mode: typeof options.mode === 'number' ? options.mode : 0o666 /* default node.js mode for files */,
		flag: typeof options.flag === 'string' ? options.flag : 'w'
	};
}

//#endregion

//#region Move / Copy

export async function move(source: string, target: string): Promise<void> {
	if (source === target) {
		return;  // simulate node.js behaviour here and do a no-op if paths match
	}

	// We have been updating `mtime` for move operations for files since the
	// beginning for reasons that are no longer quite clear, but changing
	// this could be risky as well. As such, trying to reason about it:
	// It is very common as developer to have file watchers enabled that watch
	// the current workspace for changes. Updating the `mtime` might make it
	// easier for these watchers to recognize an actual change. Since changing
	// a source code file also updates the `mtime`, moving a file should do so
	// as well because conceptually it is a change of a similar category.
	async function updateMtime(path: string): Promise<void> {
		try {
			const stat = await fs.promises.lstat(path);
			if (stat.isDirectory() || stat.isSymbolicLink()) {
				return; // only for files
			}

			const fh = await fs.promises.open(path, 'a');
			try {
				await fh.utimes(stat.atime, new Date());
			} finally {
				await fh.close();
			}
		} catch (error) {
			// Ignore any error
		}
	}

	try {
		await fs.promises.rename(source, target);
		await updateMtime(target);
	} catch (error) {

		// In two cases we fallback to classic copy and delete:
		//
		// 1.) The EXDEV error indicates that source and target are on different devices
		// In this case, fallback to using a copy() operation as there is no way to
		// rename() between different devices.
		//
		// 2.) The user tries to rename a file/folder that ends with a dot. This is not
		// really possible to move then, at least on UNC devices.
		if (source.toLowerCase() !== target.toLowerCase() && error.code === 'EXDEV' || source.endsWith('.')) {
			await copy(source, target);
			await rimraf(source, RimRafMode.MOVE);
			await updateMtime(target);
		} else {
			throw error;
		}
	}
}

// When copying a file or folder, we want to preserve the mode
// it had and as such provide it when creating. However, modes
// can go beyond what we expect (see link below), so we mask it.
// (https://github.com/nodejs/node-v0.x-archive/issues/3045#issuecomment-4862588)
//
// The `copy` method is very old so we should probably revisit
// it's implementation and check wether this mask is still needed.
const COPY_MODE_MASK = 0o777;

export async function copy(source: string, target: string, handledSourcesIn?: { [path: string]: boolean }): Promise<void> {

	// Keep track of paths already copied to prevent
	// cycles from symbolic links to cause issues
	const handledSources = handledSourcesIn ?? Object.create(null);
	if (handledSources[source]) {
		return;
	} else {
		handledSources[source] = true;
	}

	const { stat, symbolicLink } = await SymlinkSupport.stat(source);
	if (symbolicLink?.dangling) {
		return; // skip over dangling symbolic links (https://github.com/microsoft/vscode/issues/111621)
	}

	if (!stat.isDirectory()) {
		return doCopyFile(source, target, stat.mode & COPY_MODE_MASK);
	}

	// Create folder
	await fs.promises.mkdir(target, { recursive: true, mode: stat.mode & COPY_MODE_MASK });

	// Copy each file recursively
	const files = await readdir(source);
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		await copy(join(source, file), join(target, file), handledSources);
	}
}

async function doCopyFile(source: string, target: string, mode: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const reader = fs.createReadStream(source);
		const writer = fs.createWriteStream(target, { mode });

		let finished = false;
		const finish = (error?: Error) => {
			if (!finished) {
				finished = true;

				// in error cases, pass to callback
				if (error) {
					return reject(error);
				}

				// we need to explicitly chmod because of https://github.com/nodejs/node/issues/1104
				fs.chmod(target, mode, error => error ? reject(error) : resolve());
			}
		};

		// handle errors properly
		reader.once('error', error => finish(error));
		writer.once('error', error => finish(error));

		// we are done (underlying fd has been closed)
		writer.once('close', () => finish());

		// start piping
		reader.pipe(writer);
	});
}

//#endregion

//#region Async FS Methods

export async function exists(path: string): Promise<boolean> {
	try {
		await fs.promises.access(path);

		return true;
	} catch {
		return false;
	}
}

//#endregion

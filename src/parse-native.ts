import path from 'path';
import {
	loadTS,
	native2posix,
	resolveReferencedTSConfigFiles,
	resolveSolutionTSConfig,
	resolveTSConfig
} from './util.js';
import { findNative } from './find-native.js';

/**
 * parse the closest tsconfig.json file with typescript native functions
 *
 * You need to have `typescript` installed to use this
 *
 * @param {string} filename - path to a tsconfig.json or a .ts source file (absolute or relative to cwd)
 * @param {ParseNativeOptions} options - options
 * @returns {Promise<ParseNativeResult>}
 * @throws {ParseNativeError}
 */
export async function parseNative(
	filename: string,
	options?: ParseNativeOptions
): Promise<ParseNativeResult> {
	const cache = options?.cache;
	if (cache?.has(filename)) {
		return cache.get(filename)!;
	}
	let tsconfigFile = await resolveTSConfig(filename);
	if (!tsconfigFile) {
		tsconfigFile = await findNative(filename);
	}
	let result: ParseNativeResult;
	if (cache?.has(tsconfigFile)) {
		result = cache.get(tsconfigFile)!;
	} else {
		const ts = await loadTS();
		result = await parseFile(tsconfigFile, ts, cache);
		await parseReferences(result, ts, cache);
		cache?.set(tsconfigFile, result);
	}

	//@ts-ignore
	result = resolveSolutionTSConfig(filename, result);
	//@ts-ignore
	cache?.set(filename, result);
	return result;
}

async function parseFile(
	tsconfigFile: string,
	ts: any,
	cache?: Map<string, ParseNativeResult>
): Promise<ParseNativeResult> {
	if (cache?.has(tsconfigFile)) {
		return cache.get(tsconfigFile)!;
	}
	const posixTSConfigFile = native2posix(tsconfigFile);
	const { parseJsonConfigFileContent, readConfigFile, sys } = ts;
	const { config, error } = readConfigFile(posixTSConfigFile, sys.readFile);
	if (error) {
		throw new ParseNativeError(error, null);
	}

	const host = {
		useCaseSensitiveFileNames: false,
		readDirectory: sys.readDirectory,
		fileExists: sys.fileExists,
		readFile: sys.readFile
	};

	const nativeResult = parseJsonConfigFileContent(
		config,
		host,
		path.dirname(posixTSConfigFile),
		undefined,
		posixTSConfigFile
	);
	checkErrors(nativeResult);
	const result: ParseNativeResult = {
		filename: tsconfigFile,
		tsconfig: result2tsconfig(nativeResult, ts),
		result: nativeResult
	};
	cache?.set(tsconfigFile, result);
	return result;
}

async function parseReferences(
	result: ParseNativeResult,
	ts: any,
	cache?: Map<string, ParseNativeResult>
) {
	if (!result.tsconfig.references) {
		return;
	}
	const referencedFiles = resolveReferencedTSConfigFiles(result);
	result.referenced = await Promise.all(referencedFiles.map((file) => parseFile(file, ts, cache)));
}

/**
 * check errors reported by parseJsonConfigFileContent
 *
 * ignores errors related to missing input files as these may happen regularly in programmatic use
 * and do not affect the config itself
 *
 * @param {nativeResult} any - native typescript parse result to check for errors
 * @throws {ParseNativeError} for critical error
 */
function checkErrors(nativeResult: any) {
	const ignoredErrorCodes = [
		// see https://github.com/microsoft/TypeScript/blob/main/src/compiler/diagnosticMessages.json
		18002, // empty files list
		18003 // no inputs
	];
	const criticalError = nativeResult.errors?.find(
		(error: TSDiagnosticError) => error.category === 1 && !ignoredErrorCodes.includes(error.code)
	);
	if (criticalError) {
		throw new ParseNativeError(criticalError, nativeResult);
	}
}

/**
 * convert the result of `parseJsonConfigFileContent` to a tsconfig that can be parsed again
 *
 * - use merged compilerOptions
 * - strip prefix and postfix of compilerOptions.lib
 * - convert enum values back to string
 *
 * @param result
 * @param ts typescript
 * @returns {object} tsconfig with merged compilerOptions and enums restored to their string form
 */
function result2tsconfig(result: any, ts: any) {
	// dereference result.raw so changes below don't modify original
	const tsconfig = JSON.parse(JSON.stringify(result.raw));
	// for some reason the extended compilerOptions are not available in result.raw but only in result.options
	// and contain an extra fields 'configFilePath' and 'pathsBasePath'. Use everything but those 2
	const ignoredOptions = ['configFilePath', 'pathsBasePath'];
	if (result.options && Object.keys(result.options).some((o) => !ignoredOptions.includes(o))) {
		tsconfig.compilerOptions = {
			...result.options
		};
		for (const ignored of ignoredOptions) {
			delete tsconfig.compilerOptions[ignored];
		}
	}

	const compilerOptions = tsconfig.compilerOptions;
	if (compilerOptions) {
		if (compilerOptions.lib != null) {
			// remove lib. and .dts from lib.es2019.d.ts etc
			compilerOptions.lib = compilerOptions.lib.map((x: string) =>
				x.replace(/^lib\./, '').replace(/\.d\.ts$/, '')
			);
		}
		const enumProperties = [
			{ name: 'importsNotUsedAsValues', enumeration: ts.ImportsNotUsedAsValues },
			{ name: 'module', enumeration: ts.ModuleKind },
			{
				name: 'moduleResolution',
				enumeration: { 1: 'classic', 2: 'node' } /*ts.ModuleResolutionKind uses different names*/
			},
			{
				name: 'newLine',
				enumeration: { 0: 'crlf', 1: 'lf' } /*ts.NewLineKind uses different names*/
			},
			{ name: 'target', enumeration: ts.ScriptTarget }
		];
		for (const prop of enumProperties) {
			if (compilerOptions[prop.name] != null && typeof compilerOptions[prop.name] === 'number') {
				compilerOptions[prop.name] = prop.enumeration[compilerOptions[prop.name]].toLowerCase();
			}
		}
	}

	// merged watchOptions
	if (result.watchOptions) {
		tsconfig.watchOptions = {
			...result.watchOptions
		};
	}

	const watchOptions = tsconfig.watchOptions;
	if (watchOptions) {
		const enumProperties = [
			{ name: 'watchFile', enumeration: ts.WatchFileKind },
			{ name: 'watchDirectory', enumeration: ts.WatchDirectoryKind },
			{ name: 'fallbackPolling', enumeration: ts.PollingWatchKind }
		];
		for (const prop of enumProperties) {
			if (watchOptions[prop.name] != null && typeof watchOptions[prop.name] === 'number') {
				const enumVal = prop.enumeration[watchOptions[prop.name]];
				watchOptions[prop.name] = enumVal.charAt(0).toLowerCase() + enumVal.slice(1);
			}
		}
	}
	if (tsconfig.compileOnSave === false) {
		// ts adds this property even if it isn't present in the actual config
		// delete if it is false to match content of tsconfig
		delete tsconfig.compileOnSave;
	}
	return tsconfig;
}

export interface ParseNativeOptions {
	/**
	 * optional cache map to speed up repeated parsing with multiple files
	 * it is your own responsibility to clear the cache if tsconfig files change during its lifetime
	 * cache keys are input `filename` and absolute paths to tsconfig.json files
	 *
	 * You must not modify cached values.
	 */
	cache?: Map<string, ParseNativeResult>;
}

export interface ParseNativeResult {
	/**
	 * absolute path to parsed tsconfig.json
	 */
	filename: string;

	/**
	 * parsed result, including merged values from extended and normalized
	 */
	tsconfig: any;

	/**
	 * ParseResult for parent solution
	 */
	solution?: ParseNativeResult;

	/**
	 * ParseNativeResults for all tsconfig files referenced in a solution
	 */
	referenced?: ParseNativeResult[];

	/**
	 * full output of ts.parseJsonConfigFileContent
	 */
	result: any;
}

export class ParseNativeError extends Error {
	constructor(diagnostic: TSDiagnosticError, result?: any) {
		super(diagnostic.messageText);
		// Set the prototype explicitly.
		Object.setPrototypeOf(this, ParseNativeError.prototype);
		this.name = ParseNativeError.name;
		this.code = `TS ${diagnostic.code}`;
		this.diagnostic = diagnostic;
		this.result = result;
	}

	/**
	 * code of typescript diagnostic, prefixed with "TS "
	 */
	code: string;

	/**
	 * full ts diagnostic that caused this error
	 */
	diagnostic: any;

	/**
	 * native result if present, contains all errors in result.errors
	 */
	result: any | undefined;
}

interface TSDiagnosticError {
	code: number;
	category: number;
	messageText: string;
	start?: number;
}

import path from 'path';
import { promises as fs } from 'fs';
import { find } from './find.js';
import { toJson } from './to-json.js';
import { createRequire } from 'module';

/**
 * parse the closest tsconfig.json file
 *
 * @param {string} filename - path to a tsconfig.json or a .ts source file (absolute or relative to cwd)
 * @returns {Promise<object|void>} tsconfig parsed as object
 */
export async function parse(filename: string): Promise<ParseResult> {
	const tsconfigFile = await find(filename);
	const parseResult = await parseFile(tsconfigFile);
	if (!Object.prototype.hasOwnProperty.call(parseResult.tsconfig, 'compileOnSave')) {
		// ts.parseJsonConfigFileContent returns compileOnSave even if it is not set explicitly so add it if it wasn't
		parseResult.tsconfig.compileOnSave = false;
	}
	const result = await parseExtends(parseResult);
	deleteInvalidKeys(result.tsconfig);
	return result;
}

async function parseFile(tsconfigFile: string): Promise<ParseResult> {
	const tsconfigJson = await fs.readFile(tsconfigFile, 'utf-8');
	const json = toJson(tsconfigJson);
	return {
		filename: tsconfigFile,
		tsconfig: JSON.parse(json)
	};
}

const VALID_KEYS = [
	'extends',
	'compilerOptions',
	'files',
	'include',
	'exclude',
	'watchOptions',
	'references',
	'compileOnSave',
	'typeAcquisition'
];
function deleteInvalidKeys(tsconfig: any) {
	for (const key of Object.keys(tsconfig)) {
		if (!VALID_KEYS.includes(key)) {
			delete tsconfig[key];
		}
	}
	return tsconfig;
}

async function parseExtends(result: ParseResult): Promise<ParseResult> {
	if (!result.tsconfig.extends) {
		return result;
	}
	// use result as first element in extended
	// but dereference tsconfig so that mergeExtended can modify the original without affecting extended[0]
	const extended = [
		{ filename: result.filename, tsconfig: JSON.parse(JSON.stringify(result.tsconfig)) }
	];

	while (extended[extended.length - 1].tsconfig.extends) {
		const extending = extended[extended.length - 1];
		const extendedTSConfigFile = resolveExtends(extending.tsconfig.extends, extending.filename);
		if (extended.some((x) => x.filename === extendedTSConfigFile)) {
			const circle = extended
				.concat({ filename: extendedTSConfigFile, tsconfig: null })
				.map((e) => e.filename)
				.join(' -> ');
			throw new Error(`Circular dependency in "extends": ${circle}`);
		}
		extended.push(await parseFile(extendedTSConfigFile));
	}
	result.extended = extended;
	return mergeExtended(result);
}

function resolveExtends(extended: string, from: string): string {
	try {
		return createRequire(from).resolve(extended);
	} catch (e) {
		throw new Error(`failed to resolve "extends":"${extended}" in ${from}`);
	}
}

function mergeExtended(result: ParseResult): any {
	// skip first as it is the original config
	for (const ext of result.extended!.slice(1)) {
		extendTSConfig(result, ext);
	}
	return result;
}

// references is never inherited according to docs
const NEVER_INHERITED = ['references', 'extends'];
function extendTSConfig(extending: ParseResult, extended: ParseResult): any {
	const extendingConfig = extending.tsconfig;
	const extendedConfig = extended.tsconfig;
	const relativePath = path.relative(
		path.dirname(extending.filename),
		path.dirname(extended.filename)
	);
	for (const key of Object.keys(extendedConfig).filter((key) => !NEVER_INHERITED.includes(key))) {
		if (key === 'compilerOptions') {
			for (const option of Object.keys(extendedConfig.compilerOptions)) {
				if (Object.prototype.hasOwnProperty.call(extendingConfig.compilerOptions, option)) {
					continue; // already set
				}
				extendingConfig.compilerOptions[option] = rebaseRelative(
					option,
					extendedConfig.compilerOptions[option],
					relativePath
				);
			}
		} else if (extendingConfig[key] === undefined) {
			if (key === 'watchOptions') {
				extendingConfig.watchOptions = {};
				for (const option of Object.keys(extendedConfig.watchOptions)) {
					extendingConfig.watchOptions[option] = rebaseRelative(
						option,
						extendedConfig.compilerOptions[option],
						relativePath
					);
				}
			} else {
				extendingConfig[key] = rebaseRelative(key, extendedConfig[key], relativePath);
			}
		}
	}
}

const REBASE_KEYS = [
	// root
	'files',
	'include',
	'exclude',
	// compilerOptions
	'baseUrl',
	'paths',
	'rootDir',
	'rootDirs',
	'typeRoots',
	'outDir',
	'outFile',
	'declarationDir',
	// watchOptions
	'excludeDirectories',
	'excludeFiles'
];

type PathValue = string | string[] | { [key: string]: string };

function rebaseRelative(key: string, value: PathValue, prependPath: string): PathValue {
	if (!REBASE_KEYS.includes(key)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((x) => rebasePath(x, prependPath));
	} else if (typeof value === 'object') {
		return Object.entries(value).reduce((rebasedValue, [k, v]) => {
			rebasedValue[k] = rebasePath(v, prependPath);
			return rebasedValue;
		}, {} as { [key: string]: string });
	} else {
		return rebasePath(value as string, prependPath);
	}
}

function rebasePath(value: string, prependPath: string): string {
	if (path.isAbsolute(value)) {
		return value;
	} else {
		// relative paths use posix syntax in tsconfig
		return path.posix.normalize(path.posix.join(prependPath, value));
	}
}

export interface ParseResult {
	/**
	 * absolute path to parsed tsconfig.json
	 */
	filename: string;
	/**
	 * parsed result, including merged values from extended
	 */
	tsconfig: any;

	/**
	 * ParseResult for all tsconfig files
	 *
	 * [a,b,c] where a extends b and b extends c
	 */
	extended?: Omit<ParseResult, 'extended'>[];
}

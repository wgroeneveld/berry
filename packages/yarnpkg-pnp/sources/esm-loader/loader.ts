import {parse, init}                            from 'cjs-module-lexer';
import {ResolverFactory, CachedInputFileSystem} from 'enhanced-resolve';
import fs                                       from 'fs';
import {builtinModules, createRequire}          from 'module';
import path                                     from 'path';
import {fileURLToPath, pathToFileURL, URL}      from 'url';

import {PnpApi}                                 from "../types";

function isValidURL(str: string) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

const builtins = new Set([...builtinModules]);

const cachedFS = new CachedInputFileSystem(fs);

function isDirectory(filePath: string) {
  return new Promise<boolean>(resolve => {
    cachedFS.lstat!(filePath, (err, stat) => {
      if (err || !stat) {
        resolve(false);
      } else {
        resolve(stat.isDirectory());
      }
    });
  });
}

function readFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    cachedFS.readFile(filePath, (err, result) => {
      if (err || !result) {
        reject(err);
      } else {
        resolve(Buffer.isBuffer(result) ? result.toString(`utf8`) : result);
      }
    });
  });
}

function readJson(filePath: string) {
  return new Promise<any>((resolve, reject) => {
    cachedFS.readJson!(filePath, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

const commonResolver = ResolverFactory.createResolver({
  fileSystem: cachedFS,
  conditionNames: [`node`, `import`],
  extensions: [`.js`, `.json`],
  // TODO: Disable if --experimental-specifier-resolution=node
  fullySpecified: true,
});

// @ts-expect-error - This module, when bundled, is still ESM so this is valid
const pnpapi: PnpApi = createRequire(import.meta.url)(`pnpapi`);

// TODO: Reuse this from the other files (this is the third copy)
const pathRegExp = /^(?![a-zA-Z]:[\\/]|\\\\|\.{0,2}(?:\/|$))((?:@[^/]+\/)?[^/]+)\/*(.*|)$/;

export async function resolve(specifier: string, context: any, defaultResolver: any) {
  let validURL;
  if (builtins.has(specifier) || (validURL = isValidURL(specifier))) {
    if (!validURL || pathToFileURL(specifier).protocol !== `file:`) {
      return defaultResolver(specifier, context, defaultResolver);
    } else {
      specifier = fileURLToPath(specifier);
    }
  }

  const {parentURL, conditions = []} = context;

  const resolver =
    conditions.join(`.`) === `node.import`
      ? commonResolver
      : ResolverFactory.createResolver({
        fileSystem: cachedFS,
        conditionNames: conditions,
        extensions: [`.js`, `.json`],
        // TODO: Disable if --experimental-specifier-resolution=node
        fullySpecified: true,
      });

  let parentPath = parentURL ? fileURLToPath(parentURL) : process.cwd();
  try {
    if (specifier.startsWith(`.`) && !(await isDirectory(parentPath))) {
      parentPath = path.dirname(parentPath);
    }
  } catch {}

  return new Promise((resolve, reject) => {
    resolver.resolve({}, parentPath, specifier, {}, (err, file) => {
      if (err || !file) {
        reject(err);
      } else {
        // Guard against https://github.com/webpack/enhanced-resolve/issues/273
        if (specifier.match(pathRegExp) !== null && !pnpapi.findPackageLocator(file)) {
          reject(new Error(`'enhanced-resolve' went outside of the pnpapi and resolved '${specifier}' to '${file}'`));
        } else {
          resolve({url: pathToFileURL(file).href});
        }
      }
    });
  });
}

const realModules = new Set<string>();

export async function getFormat(resolved: string, context: any, defaultGetFormat: any) {
  const parsedURL = new URL(resolved);
  if (parsedURL.protocol !== `file:`)
    return defaultGetFormat(resolved, context, defaultGetFormat);

  switch (path.extname(parsedURL.pathname)) {
    case `.mjs`: {
      realModules.add(fileURLToPath(resolved));
      return {
        format: `module`,
      };
    }
    case `.json`: {
      // TODO: Enable if --experimental-json-modules is present
      throw new Error(`Unknown file extension ".json" for ${fileURLToPath(resolved)}`);
      return {
        format: `module`,
      };
    }
    default: {
      let packageJSONUrl = new URL(`./package.json`, resolved);
      while (true) {
        if (packageJSONUrl.pathname.endsWith(`node_modules/package.json`)) break;

        const filePath = fileURLToPath(packageJSONUrl);

        try {
          let moduleType = (await readJson(filePath)).type ?? `commonjs`;
          if (moduleType === `commonjs`)
            moduleType = `module`;
          else
            realModules.add(fileURLToPath(resolved));

          return {
            format: moduleType,
          };
        } catch {}

        const lastPackageJSONUrl = packageJSONUrl;
        packageJSONUrl = new URL(`../package.json`, packageJSONUrl);

        if (packageJSONUrl.pathname === lastPackageJSONUrl.pathname) {
          break;
        }
      }
    }
  }

  throw new Error(`Unable to get module type of '${resolved}'`);
}

let parserInit: Promise<void> | null = init().then(() => {
  parserInit = null;
});

async function parseExports(filePath: string) {
  const {exports} = parse(await readFile(filePath));

  return new Set(exports);
}

export async function getSource(urlString: string, context: any, defaultGetSource: any) {
  const url = new URL(urlString);
  if (url.protocol !== `file:`) return defaultGetSource(url, context, defaultGetSource);

  urlString = fileURLToPath(urlString);

  if (realModules.has(urlString)) {
    return {
      source: await readFile(urlString),
    };
  }

  if (parserInit !== null) await parserInit;

  const exports = await parseExports(urlString);

  let exportStrings = `export default cjs\n`;
  for (const exportName of exports) {
    if (exportName !== `default`) {
      exportStrings += `const __${exportName} = cjs['${exportName}'];\n export { __${exportName} as ${exportName} }\n`;
    }
  }

  const fakeModulePath = path.join(path.dirname(urlString), `noop.js`);

  const code = `
  import {createRequire} from 'module';
  const require = createRequire('${fakeModulePath.replace(/\\/g,`/`)}');
  const cjs = require('${urlString.replace(/\\/g,`/`)}');
  
  ${exportStrings}
  `;

  return {
    source: code,
  };
}

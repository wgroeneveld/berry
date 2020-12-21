import {ResolverFactory, CachedInputFileSystem} from 'enhanced-resolve';
import fs                                       from 'fs';
import {builtinModules}                         from 'module';
import path                                     from 'path';
import {fileURLToPath, pathToFileURL, URL}      from 'url';

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
  return new Promise<boolean>((resolve, reject) => {
    cachedFS.lstat(filePath, (err, stat) => {
      if (err) {
        reject(err);
      } else {
        resolve(stat.isDirectory());
      }
    });
  });
}

function readFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    cachedFS.readFile(filePath, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(Buffer.isBuffer(result) ? result.toString(`utf8`) : result);
      }
    });
  });
}

function readJson(filePath: string) {
  return new Promise<any>((resolve, reject) => {
    cachedFS.readJson(filePath, (err, result) => {
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
  extensions: [`.mjs`, `.cjs`, `.js`, `.json`],
});

export async function resolve(specifier: string, context: any, defaultResolver: any) {
  if (builtins.has(specifier) || isValidURL(specifier)) return defaultResolver(specifier, context, defaultResolver);

  const {parentURL, conditions = []} = context;

  const resolver =
    conditions.join(`.`) === `node.import`
      ? commonResolver
      : ResolverFactory.createResolver({
        fileSystem: cachedFS,
        conditionNames: conditions,
        extensions: [`.mjs`, `.cjs`, `.js`, `.json`],
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
        resolve({url: pathToFileURL(file).href});
      }
    });
  });
}

const moduleTypeCache = new Map<string, string>();

export async function getFormat(resolved: string, context: any, defaultGetFormat: any) {
  const parsedURL = new URL(resolved);
  if (parsedURL.protocol !== `file:` || !parsedURL.pathname.endsWith(`.js`))
    return defaultGetFormat(resolved, context, defaultGetFormat);

  let packageJSONUrl = new URL(`./package.json`, resolved);
  while (true) {
    if (packageJSONUrl.pathname.endsWith(`node_modules/package.json`)) break;

    const filePath = fileURLToPath(packageJSONUrl);
    const cachedType = moduleTypeCache.get(filePath);
    if (cachedType) return {format: cachedType};

    try {
      const moduleType = (await readJson(filePath)).type ?? `commonjs`;
      moduleTypeCache.set(filePath, moduleType);
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

  throw new Error(`Unable to get module type of '${resolved}'`);
}

export async function getSource(urlString: string, context: any, defaultGetSource: any) {
  const url = new URL(urlString);
  if (url.protocol !== `file:`) return defaultGetSource(url, context, defaultGetSource);

  return {
    source: await readFile(fileURLToPath(url)),
  };
}

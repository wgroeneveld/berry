import alias                from '@rollup/plugin-alias';
import cjs                  from '@rollup/plugin-commonjs';
import resolve              from '@rollup/plugin-node-resolve';
import ts                   from '@rollup/plugin-typescript';
import {brotliCompressSync} from 'zlib';

// eslint-disable-next-line arca/no-default-export
export default {
  input: `./sources/esm-loader/loader.ts`,
  output: {
    file: `./sources/esm-loader/built-loader.js`,
    format: `esm`,
  },
  plugins: [
    alias({
      entries: [{find: `pnpapi`, replacement: require.resolve(`./sources/esm-loader/stub.ts`)}],
    }),
    resolve({preferBuiltins: true}),
    ts({skipLibCheck: true, target: `ES2018`, allowSyntheticDefaultImports: true}),
    cjs({requireReturnsDefault: `preferred`}),
    {
      name: `wrap-output`,
      generateBundle(options, bundle, isWrite) {
        const bundles = Object.keys(bundle);
        if (bundles.length !== 1) throw new Error(`Expected only one bundle, got ${bundles.length}`);
        const outputBundle = bundle[bundles[0]];

        outputBundle.code = `let hook;\n\nmodule.exports = () => {\n  if (typeof hook === \`undefined\`)\n    hook = require('zlib').brotliDecompressSync(Buffer.from('${brotliCompressSync(
          outputBundle.code.replace(/\r\n/g, `\n`)
        ).toString(`base64`)}', 'base64')).toString();\n\n  return hook;\n};\n`;
      },
    },
  ],
};

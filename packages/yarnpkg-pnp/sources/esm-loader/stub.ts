import {createRequire} from 'module';

// @ts-expect-error
// eslint-disable-next-line arca/no-default-export
export default createRequire(import.meta.url)(`pnpapi`);

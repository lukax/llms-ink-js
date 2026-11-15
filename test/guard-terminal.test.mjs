import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const python=process.env.LLMS_INK_GUARD_TEST_PYTHON;
test('shipped terminal displays actual tool results, separates prose and closes on interruption',{skip:!python||process.platform==='win32',timeout:65000},()=>{
 execFileSync(python,[fileURLToPath(new URL('./guard-terminal.py',import.meta.url))],{env:{...process.env,LLMS_INK_TERMINAL_TEST_NODE:process.execPath},stdio:'pipe',timeout:60000});
});

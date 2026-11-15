"""Drive the distributed terminal entry point, not just its host API."""
import errno
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import time
import unittest

NODE = os.environ['LLMS_INK_TERMINAL_TEST_NODE']
ROOT = Path(__file__).resolve().parent.parent
COMMAND = [NODE, '--experimental-test-module-mocks', '--import', str(ROOT/'test/fixtures/guard-terminal-preload.mjs'), str(ROOT/'examples/guard-claude.mjs'), '--owner-file', '/fixture/owner.json', '--python', '/fixture/python', '--cwd', '/fixture']

class Terminal:
    def __init__(self):
        self.master, slave = pty.openpty()
        self.output = b''
        self.child = subprocess.Popen(COMMAND, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
    def read(self):
        if select.select([self.master], [], [], .05)[0]:
            try: self.output += os.read(self.master, 16384)
            except OSError as error:
                if error.errno != errno.EIO: raise
        if len(self.output) > 1048576: raise AssertionError('Unexpected terminal output volume')
    def until(self, marker, timeout=10):
        deadline = time.monotonic() + timeout
        while marker not in self.output:
            self.read()
            if time.monotonic() > deadline or self.child.poll() is not None:
                raise AssertionError('Terminal did not reach expected prompt: '+repr(self.output))
        found = self.output
        self.output = b''
        return found.replace(b'\r\n', b'\n').decode()
    def send(self, text): os.write(self.master, text.encode()+b'\n')
    def finish(self):
        deadline = time.monotonic()+10
        while self.child.poll() is None:
            self.read()
            if time.monotonic()>deadline: raise AssertionError('Terminal did not exit')
        self.read()
        return self.output.replace(b'\r\n',b'\n').decode()
    def close(self):
        if self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait(timeout=5)
        os.close(self.master)

class TerminalTests(unittest.TestCase):
    def start(self):
        terminal=Terminal();self.addCleanup(terminal.close);terminal.until(b'You: ');return terminal
    def test_real_entry_point_displays_results_and_errors_separately_from_model_prose(self):
        terminal=self.start();terminal.send('outputs');output=terminal.until(b'You: ')
        self.assertIn('Claude: CLAIM_ONLY',output)
        self.assertIn('Claude: Tool response (error)\\u000d\\u001b[2J\\u202e',output)
        self.assertIn('\nTool response\n',output)
        self.assertIn('\nTool response (error)\n',output)
        self.assertIn('RESULT_ONLY',output);self.assertIn('DENIED_BY_GUARD',output)
        self.assertIn('call-1',output);self.assertIn('call-2',output)
        self.assertNotIn('\x1b[2J',output);self.assertNotIn('\u202e',output)
        terminal.send('/exit');self.assertIn('FIXTURE_CLOSED',terminal.finish());self.assertEqual(terminal.child.returncode,0)
    def test_prose_only_does_not_invent_a_tool_response_or_echo_user_input(self):
        terminal=self.start();terminal.send('prose');output=terminal.until(b'You: ')
        self.assertIn('Claude: CLAIM_ONLY',output)
        self.assertNotIn('\nTool response',output);self.assertNotIn('PRIVATE_PROMPT_NOT_OUTPUT',output)
        terminal.send('/exit');terminal.finish();self.assertEqual(terminal.child.returncode,0)
    def test_enter_declines_and_explicit_approval_is_visible(self):
        terminal=self.start()
        for answer,expected in [('', 'FIXTURE_DECLINED'),('approve','FIXTURE_APPROVED')]:
            terminal.send('review');review=terminal.until(b'Type approve to send this call once; Enter declines: ')
            self.assertIn('REVIEW_ONLY\\u000d\\u001b[2J\\u202e',review)
            terminal.send(answer);output=terminal.until(b'You: ');self.assertIn(expected,output)
        terminal.send('/exit');terminal.finish();self.assertEqual(terminal.child.returncode,0)
    def test_sigterm_during_review_closes_the_session(self):
        terminal=self.start();terminal.send('review');terminal.until(b'Enter declines: ')
        terminal.child.terminate();output=terminal.finish()
        self.assertIn('FIXTURE_CLOSED',output);self.assertNotIn('FIXTURE_APPROVED',output);self.assertEqual(terminal.child.returncode,0)
    def test_nonterminal_input_refuses_before_creating_a_session(self):
        result=subprocess.run(COMMAND,input='approve\n',capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0);self.assertNotIn('FIXTURE_CLOSED',result.stdout)
        self.assertIn('interactive terminal',result.stderr)

if __name__=='__main__':unittest.main()

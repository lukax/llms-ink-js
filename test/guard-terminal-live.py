"""Opt-in real Claude terminal smoke; synthetic local effects, no human participants."""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time

if os.environ.get('LLMS_INK_CLAUDE_LIVE') != '1':
    raise SystemExit('Set LLMS_INK_CLAUDE_LIVE=1 to use authenticated Claude and the local model')
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('terminal_tests',ROOT/'test/guard-terminal.py')
terminal_tests=importlib.util.module_from_spec(spec);spec.loader.exec_module(terminal_tests)
from llms_ink.guard_service import control

with tempfile.TemporaryDirectory(prefix='ink-terminal-live-') as directory:
    root=Path(directory);terminal=None
    with tempfile.TemporaryFile() as errors:
        service=subprocess.Popen([sys.executable,str(ROOT/'test/fixtures/guard-service.py'),directory],stdout=subprocess.PIPE,stderr=errors,env={**os.environ,'LLMS_INK_HOST_REAL_MODEL':'1'})
        try:
            assert select.select([service.stdout],[],[],40)[0], 'Service startup deadline'
            owner=Path(json.loads(service.stdout.readline())['ownerFile'])
            deadline=time.monotonic()+15
            while True:
                try: control(owner,'status');break
                except (OSError,ValueError,RuntimeError):
                    assert time.monotonic()<deadline
                    time.sleep(.1)
            package=Path(os.environ.get('LLMS_INK_TERMINAL_PACKAGE',ROOT))
            terminal_tests.COMMAND=[os.environ['LLMS_INK_TERMINAL_TEST_NODE'],str(package/'examples/guard-claude.mjs'),'--owner-file',str(owner),'--python',sys.executable,'--cwd',directory,'--model','haiku']
            if os.environ.get('LLMS_INK_CLAUDE_EXECUTABLE'):
                terminal_tests.COMMAND+=['--claude-executable',os.environ['LLMS_INK_CLAUDE_EXECUTABLE']]
            terminal=terminal_tests.Terminal();terminal.until(b'You: ',timeout=40)
            state=control(owner,'status')['sessions'];assert len(state)==1 and state[0]['hostBound'] and state[0]['hostConnected']
            prompt='Call mcp__guarded__fixture__record exactly once with destination "safe". This records only an inert local test event. If denied, do not retry or substitute arguments. Then stop.'
            for answer,count in [('',0),('approve',1)]:
                terminal.send(prompt);terminal.until(b'Type approve to send this call once; Enter declines: ',timeout=90)
                terminal.send(answer);output=terminal.until(b'You: ',timeout=90)
                assert '\nTool response'+(' (error)' if not answer else '')+'\n' in output, 'Expected actual tool response in terminal'
                assert '"toolUseId"' in output
                if answer: assert 'Recorded local test event.' in output
                effects=(root/'effects').read_text().splitlines() if (root/'effects').exists() else []
                assert len(effects)==count
            terminal.send('/exit');terminal.finish();assert terminal.child.returncode==0
            assert not any(s['active'] for s in control(owner,'status')['sessions'])
            print(json.dumps({'terminalWorkflowPassed':True,'declineVisible':True,'approvedResultVisible':True,'fixtureEffects':1,'revocationObserved':True,'humanParticipants':0}))
        finally:
            if terminal: terminal.close()
            if service.poll() is None:service.terminate()
            try:service.wait(timeout=15)
            except subprocess.TimeoutExpired:service.kill();service.wait(timeout=5);raise
            service.stdout.close()
            assert service.returncode==0,'Service cleanup failed'
            if (root/'pids').exists():
                for pid in (root/'pids').read_text().splitlines():
                    try:os.kill(int(pid),0)
                    except ProcessLookupError:continue
                    raise AssertionError('Fixture server survived cleanup')

"""Local-only service and inert tool fixture for the Node host adapter tests."""
import json, os, signal, sys
from pathlib import Path

TOOL={'name':'record','description':'Record an inert local test event. No network access or real messages.','inputSchema':{'type':'object','properties':{'destination':{'type':'string'}},'required':['destination'],'additionalProperties':False}}
if __name__=='__main__' and len(sys.argv)>2 and sys.argv[1]=='server':
    directory=Path(sys.argv[2])
    with (directory/'pids').open('a') as out: out.write(str(os.getpid())+'\n')
    for raw in sys.stdin:
        m=json.loads(raw)
        if 'id' not in m or 'method' not in m: continue
        if m['method']=='initialize':
            body={'protocolVersion':m['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
        elif m['method']=='tools/list': body={'tools':[TOOL]}
        elif m['method']=='tools/call':
            with (directory/'effects').open('a') as out: out.write(json.dumps(m['params'])+'\n')
            body={'content':[{'type':'text','text':'Recorded local test event.'}]}
        else: body={}
        print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':body}),flush=True)
elif __name__=='__main__':
    from llms_ink.guard import LocalGuard, receipt
    from llms_ink.guard_service import Service, initialize
    directory=Path(sys.argv[1]); initialize(directory)
    config={'version':1,'servers':{'fixture':{'command':[sys.executable,str(Path(__file__).resolve()),'server',str(directory)],'tools':[{'definition':TOOL,'arguments':[{'destination':'safe'}]}]}}}
    path=directory/'gateway.json';path.write_text(json.dumps(config));path.chmod(0o600)
    class Allow:
        def inspect(self,text):return receipt('allow','no_finding',coverage='complete')
        def close(self):pass
    guard=LocalGuard() if os.environ.get('LLMS_INK_HOST_REAL_MODEL')=='1' else Allow()
    service=Service(directory/'owner.json',str(path),guard,log=lambda event:None)
    signal.signal(signal.SIGTERM,lambda *_:service.stop.set())
    signal.signal(signal.SIGINT,lambda *_:service.stop.set())
    # Node probes authenticated owner status after receiving this path.
    print(json.dumps({'ownerFile':str(directory/'owner.json')}),flush=True)
    service.run()

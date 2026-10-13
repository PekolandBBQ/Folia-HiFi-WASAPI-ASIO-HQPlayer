'use strict';

// Fixed read-only main diagnostic. It asks systemd for known unit properties,
// never journal/configuration, process argv, keys or account identifiers.
const units = Object.freeze(['folia-credentials-ready.path', 'folia-runtime.target', 'folia-music-assistant.service',
  'folia-sendspin-bootstrap.service', 'folia-sendspin.service', 'folia-spotify-bootstrap.service', 'folia-pairing-relay.service']);
const active = Object.freeze(['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing', 'unknown']);
const sub = Object.freeze(['dead', 'failed', 'running', 'exited', 'waiting', 'listening', 'start-pre', 'start', 'start-post',
  'stop', 'stop-sigterm', 'stop-sigkill', 'stop-post', 'final-sigterm', 'final-sigkill', 'auto-restart', 'auto-restart-queued', 'active', 'inactive', 'unknown']);
const load = Object.freeze(['loaded', 'not-found', 'bad-setting', 'error', 'masked', 'stub', 'merged', 'unknown']);
const result = Object.freeze(['success', 'resources', 'timeout', 'exit-code', 'signal', 'core-dump', 'watchdog', 'start-limit-hit', 'protocol', 'exec-condition', 'oom-kill', 'unknown']);
const termination = Object.freeze(['none', 'exited', 'killed', 'dumped', 'unknown']);
const integer = value => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 100000000;
const booleans = value => value === null || typeof value === 'boolean';
const source = String.raw`
import json
import subprocess
import sys

UNITS = ('folia-credentials-ready.path','folia-runtime.target','folia-music-assistant.service','folia-sendspin-bootstrap.service','folia-sendspin.service','folia-spotify-bootstrap.service','folia-pairing-relay.service')
ACTIVE = ('active','reloading','inactive','failed','activating','deactivating','maintenance','refreshing','unknown')
SUB = ('dead','failed','running','exited','waiting','listening','start-pre','start','start-post','stop','stop-sigterm','stop-sigkill','stop-post','final-sigterm','final-sigkill','auto-restart','auto-restart-queued','active','inactive','unknown')
LOAD = ('loaded','not-found','bad-setting','error','masked','stub','merged','unknown')
RESULT = ('success','resources','timeout','exit-code','signal','core-dump','watchdog','start-limit-hit','protocol','exec-condition','oom-kill','unknown')
PROPERTIES = ('LoadState','ActiveState','SubState','Result','ExecMainCode','ExecMainStatus','MainPID','NRestarts','ConditionResult','AssertResult')

def number(value):
    if type(value) is not str or not value or len(value)>9 or not value.isascii() or not value.isdecimal(): return None
    parsed=int(value)
    return parsed if 0<=parsed<=100000000 else None

def choice(value, allowed):
    return value if value in allowed else 'unknown'

def flag(value):
    return True if value=='yes' else False if value=='no' else None

def project(unit, raw):
    values={}
    if type(raw) is not bytes or len(raw)>4096: raise ValueError()
    for line in raw.decode('utf8','strict').splitlines():
        key, separator, value=line.partition('=')
        if not separator or key not in PROPERTIES or key in values: raise ValueError()
        values[key]=value
    if not {'LoadState','ActiveState','SubState'} <= set(values): raise ValueError()
    code=number(values.get('ExecMainCode'))
    pid=number(values.get('MainPID'))
    return {'unit':unit,'available':True,'loadState':choice(values.get('LoadState'),LOAD),
      'activeState':choice(values.get('ActiveState'),ACTIVE),'subState':choice(values.get('SubState'),SUB),
      'result':choice(values.get('Result'),RESULT),'exitCode':number(values.get('ExecMainStatus')),
      'termination':{0:'none',1:'exited',2:'killed',3:'dumped'}.get(code,'unknown'),'hasMainProcess':pid is not None and pid>1,
      'restarts':number(values.get('NRestarts')),'conditionPassed':flag(values.get('ConditionResult')),'assertPassed':flag(values.get('AssertResult'))}

def unavailable(unit):
    return {'unit':unit,'available':False,'loadState':'unknown','activeState':'unknown','subState':'unknown',
      'result':'unknown','exitCode':None,'termination':'unknown','hasMainProcess':False,'restarts':None,
      'conditionPassed':None,'assertPassed':None}

def collect():
    values=[]
    for unit in UNITS:
        try:
            child=subprocess.run(['/usr/bin/systemctl','show','--no-pager','--property='+','.join(PROPERTIES),unit],
              stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,check=False)
            if child.returncode!=0: raise ValueError()
            values.append(project(unit,child.stdout))
        except Exception: values.append(unavailable(unit))
    return {'schema':1,'units':values}

def main():
    if sys.platform!='linux' or len(sys.argv)!=1: return 1
    print(json.dumps({'ok':True,'result':collect()},separators=(',',':'),allow_nan=False),flush=True)
    return 0

if __name__=='__main__': raise SystemExit(main())
`;
const command = "/usr/bin/python3 -I -c 'import base64;exec(compile(base64.b64decode(\"" + Buffer.from(source).toString('base64') + "\"),\"<folia-unit-diagnostic>\",\"exec\"))'";
function validateSoloistStartupDiagnostics(value) {
  if (process.type === 'renderer' || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'schema,units' || value.schema !== 1 || !Array.isArray(value.units)
    || value.units.length !== units.length) throw Object.assign(Error('Spotify appliance: GUEST_PROTOCOL_INVALID'), { code: 'GUEST_PROTOCOL_INVALID' });
  const projected = value.units.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'activeState,assertPassed,available,conditionPassed,exitCode,hasMainProcess,loadState,restarts,result,subState,termination,unit'
      || item.unit !== units[index] || typeof item.available !== 'boolean' || typeof item.hasMainProcess !== 'boolean'
      || !active.includes(item.activeState) || !sub.includes(item.subState) || !load.includes(item.loadState)
      || !result.includes(item.result) || !termination.includes(item.termination) || !integer(item.exitCode) || !integer(item.restarts)
      || !booleans(item.conditionPassed) || !booleans(item.assertPassed)) throw Object.assign(Error('Spotify appliance: GUEST_PROTOCOL_INVALID'), { code: 'GUEST_PROTOCOL_INVALID' });
    return Object.freeze({ ...item });
  });
  return Object.freeze({ schema: 1, units: Object.freeze(projected) });
}
module.exports = { soloistStartupDiagnosticsCommand: command, validateSoloistStartupDiagnostics };

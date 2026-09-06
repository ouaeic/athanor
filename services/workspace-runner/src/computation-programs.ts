/** Protocol packets remain untrusted cell output; they never authorize tools or arbitrary paths. */
export const PYTHON_COMPUTATION = String.raw`
import sys, json, ast, asyncio, inspect, traceback, builtins, io, base64
_token = sys.argv[1]
_wire = sys.stdout
_json = json.dumps
_state = {'__name__': '__garden__'}
def _send(value):
    _wire.write(_token + _json(value, ensure_ascii=True, allow_nan=False) + '\n')
    _wire.flush()
def _summary(value):
    kind = type(value)
    name = kind.__name__
    if kind in (str, int, float, bool, type(None)):
        try: return {'type': name, 'preview': _json(value, allow_nan=False)[:300]}
        except (ValueError, OverflowError): return {'type': name}
    if kind in (list, dict, tuple, set, bytes): return {'type': name, 'preview': str(len(value)) + ' items'}
    return {'type': name}
def _variables():
    return [dict(name=k, **_summary(v)) for k,v in list(_state.items()) if not k.startswith('_')][:100]
class _Output:
    def __init__(self, stream, cell): self.stream, self.cell = stream, cell
    def write(self, value):
        for i in range(0, len(value), 4096): _send({'kind':'output','cellId':self.cell,'stream':self.stream,'text':value[i:i+4096]})
        return len(value)
    def flush(self): pass
    def isatty(self): return False
def _json_value(value, depth=0):
    if depth > 12: raise ValueError('Checkpoint exceeds nesting limit')
    if type(value) in (str, int, float, bool, type(None)): return value
    if type(value) in (list, tuple): return [_json_value(v,depth+1) for v in value]
    if type(value) is dict and all(type(k) is str for k in value): return {k:_json_value(v,depth+1) for k,v in value.items()}
    raise ValueError('Checkpoints accept JSON values only')
_send({'kind':'ready'})
for _line in sys.stdin:
    try:
        _request = json.loads(_line)
        _id = _request['cellId']
        _error = None
        _result = None
        _artifacts = []
        _previous_out, _previous_err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = _Output('stdout',_id), _Output('stderr',_id)
        try:
            if _request['action'] == 'checkpoint':
                _result = {'checkpoint': {k:_json_value(_state[k]) for k in _request['variables']}}
                if len(_json(_result)) > 1048576: raise ValueError('Checkpoint exceeds one MiB')
            elif _request['action'] == 'restore':
                _values = _request['values']
                if not all(type(k) is str and k.isidentifier() and not k.startswith('_') for k in _values):
                    raise ValueError('Checkpoint variable names must be public identifiers')
                _state.update(_values)
            else:
                _tree = ast.parse(_request['code'])
                if _tree.body and isinstance(_tree.body[-1], ast.Expr):
                    _tree.body[-1] = ast.Assign(targets=[ast.Name(id='_',ctx=ast.Store())],value=_tree.body[-1].value)
                else: _state['_'] = None
                ast.fix_missing_locations(_tree)
                _value = eval(compile(_tree, 'garden-cell.py', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT),_state)
                if inspect.isawaitable(_value): asyncio.run(_value)
                _value = _state.get('_')
                _result = _summary(_value)
                if type(_value) in (str,int,float,bool,type(None)):
                    try:
                        if len(_json(_value,allow_nan=False)) < 16000: _result['value'] = _value
                    except (ValueError, OverflowError): pass
                if 'matplotlib.figure' in sys.modules and isinstance(_value, sys.modules['matplotlib.figure'].Figure):
                    _buffer = io.BytesIO()
                    _value.savefig(_buffer,format='png',dpi=100)
                    if _buffer.tell() > 2097152: raise ValueError('Plot exceeds two MiB; reduce figure size')
                    _artifacts.append({'mimeType':'image/png','base64':base64.b64encode(_buffer.getvalue()).decode('ascii')})
        except BaseException as _exception:
            _error = {'interrupted': isinstance(_exception,KeyboardInterrupt),'message': ''.join(traceback.format_exception_only(type(_exception),_exception))[:8000]}
        finally: sys.stdout,sys.stderr = _previous_out,_previous_err
        _send({'kind':'done','cellId':_id,'result':_result,'error':_error,'variables':_variables(),'artifacts':_artifacts})
    except BaseException as _exception:
        _send({'kind':'fatal','message':str(type(_exception).__name__)})
`;

export const JAVASCRIPT_COMPUTATION = String.raw`
const repl = require('node:repl');
const readline = require('node:readline');
const { PassThrough } = require('node:stream');
const { Console } = require('node:console');
const token = process.argv[1];
const wire = process.stdout.write.bind(process.stdout);
const stringify = JSON.stringify;
const send = value => wire(token + stringify(value) + '\n');
const input = new PassThrough(), output = new PassThrough();
const server = repl.start({ prompt:'',input,output,terminal:false,useGlobal:false,breakEvalOnSigint:true });
let active = null, plots = [];
const stream = name => new (require('node:stream').Writable)({write(chunk,enc,done){
  if(active) for(let i=0;i<chunk.length;i+=4096) send({kind:'output',cellId:active,stream:name,text:chunk.subarray(i,i+4096).toString()});
  done();
}});
server.context.console = new Console({stdout:stream('stdout'),stderr:stream('stderr')});
server.context.garden = Object.freeze({plot: value => {if(plots.length>=4)throw Error('Cell plot limit reached'); plots.push(value);}});
const evaluate = code => new Promise((resolve,reject)=>server.eval(code+'\n',server.context,'garden-cell.js',(error,value)=>error?reject(error):resolve(value)));
const summary = value => {
 const type = value === null ? 'null' : typeof value;
 if(['string','number','boolean','undefined','bigint','null'].includes(type))return {type,preview:String(value).slice(0,300)};
 if(Array.isArray(value))return {type:'Array'};
 return {type};
};
const inspector = new (require('node:inspector').Session)();inspector.connect();
const inspect = (method,params={})=>new Promise((resolve,reject)=>inspector.post(method,params,(error,result)=>error?reject(error):resolve(result)));
const contexts=[];inspector.on('Runtime.executionContextCreated',event=>contexts.push(event.params.context));
server.context.__garden_context_marker = token;
let executionContextId;
const initialized = (async()=>{
 await inspect('Runtime.enable');
 for(const context of contexts){
  const result=await inspect('Runtime.evaluate',{expression:'globalThis.__garden_context_marker',contextId:context.id,returnByValue:true});
  if(result.result.value===token){executionContextId=context.id;break;}
 }
 if(!executionContextId)throw Error('Native lexical context unavailable');
})();
const baseline = new Set(Object.keys(server.context));
async function variables(){
 const lexical=(await inspect('Runtime.globalLexicalScopeNames',{executionContextId})).names;
 const listed=[...new Set([...Object.keys(server.context).filter(name=>!baseline.has(name)),...lexical])].filter(name=>!name.startsWith('_')).slice(0,100);
 const values=[];
 for(const name of listed){
  const property=Object.getOwnPropertyDescriptor(server.context,name);
  if(property&&!('value' in property)){values.push({name,type:'accessor'});continue;}
  try{values.push({name,...summary(property?property.value:await evaluate(name))});}catch{values.push({name,type:'unavailable'});}
 }
 return values;
}
function jsonValue(value,depth=0){
 if(depth>12)throw Error('Checkpoint exceeds nesting limit');
 if(typeof value==='number'&&!Number.isFinite(value))throw Error('Checkpoint requires finite JSON numbers');
 if(value===null||['string','boolean','number'].includes(typeof value))return value;
 if(require('node:util').types.isProxy(value))throw Error('Checkpoint cannot inspect proxies');
 if(Array.isArray(value))return value.map(item=>jsonValue(item,depth+1));
 if(typeof value==='object'&&value!==null){
   const result=Object.create(null);
   for(const [key,property] of Object.entries(Object.getOwnPropertyDescriptors(value))){
     if(!('value' in property))throw Error('Checkpoint cannot execute getters');
     result[key]=jsonValue(property.value,depth+1);
   }
   return result;
 }
 throw Error('Checkpoints accept JSON values only');
}
let tail=Promise.resolve();
readline.createInterface({input:process.stdin}).on('line',line=>{ tail=tail.then(async()=>{
 let request;
 try{request=JSON.parse(line);}catch{send({kind:'fatal',message:'Invalid request'});return;}
 active=request.cellId;plots=[];
 let result=null,error=null;
 try{
  if(request.action==='checkpoint'){
   const checkpoint=Object.create(null);
   for(const name of request.variables){if(!/^[A-Za-z$][\w$]*$/.test(name))throw Error('Invalid variable name');const property=Object.getOwnPropertyDescriptor(server.context,name);if(property&&!('value' in property))throw Error('Checkpoint cannot execute getters');checkpoint[name]=jsonValue(property?property.value:await evaluate(name));}
   result={checkpoint};if(stringify(result).length>1048576)throw Error('Checkpoint exceeds one MiB');
  }else if(request.action==='restore'){
   const lexical=(await inspect('Runtime.globalLexicalScopeNames',{executionContextId})).names;
   for(const name of Object.keys(request.values)){
    if(!/^[A-Za-z$][\w$]*$/.test(name))throw Error('Invalid variable name');
    if(lexical.includes(name)||Object.getOwnPropertyDescriptor(server.context,name)?.configurable===false)throw Error('Restore requires unbound or configurable variable names');
   }
   for(const [name,value] of Object.entries(request.values))Object.defineProperty(server.context,name,{value,writable:true,enumerable:true,configurable:true});
  }else{
   const value=await evaluate(request.code);result=summary(value);
   if(value===null||['string','boolean','number'].includes(typeof value))if(stringify(value).length<16000)result.value=value;
  }
 }catch(caught){error={message:String(caught?.stack??caught).slice(0,8000),interrupted:caught?.code==='ERR_SCRIPT_EXECUTION_INTERRUPTED'};}
 const cached=await variables();
 send({kind:'done',cellId:active,result,error,variables:cached,artifacts:plots.map(plot=>({mimeType:'application/vnd.garden.plot+json',plot}))});active=null;
 }).catch(()=>send({kind:'fatal',message:'Computation protocol failed'}));});
process.stdin.on('end',()=>{server.close();process.exit(0);});
initialized.then(()=>send({kind:'ready'}),()=>send({kind:'fatal',message:'Native context initialization failed'}));
`;

"""Start the real relay agent on an enrolled host and abandon its input before a turn."""
import gzip
import base64
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

host = sys.argv[1]
source = (Path(__file__).resolve().parents[1] / "bin/claude-origin-relay.mjs").read_text()
agent = re.search(r"const AGENT = String.raw`(.*?)\n`;",source,re.S).group(1)
spec = {"cwd":"/tmp/bb-origin-disconnect-" + uuid.uuid4().hex,"args":["-p","--verbose","--input-format","stream-json","--output-format","stream-json","--tools="]}
def encode(text):
    return base64.b64encode(text.encode()).decode()
cmd = "stty raw -echo; exec node -e 'eval(Buffer.from(\""+encode(agent)+"\",\"base64\").toString())' "+base64.b64encode(gzip.compress(json.dumps(spec).encode())).decode()
created = json.loads(subprocess.check_output(["bb","terminal","create","--machine",host,"--cwd","/tmp","--title","isolated relay disconnect test","--command",cmd,"--json"]))
terminal=created["id"]
start=time.monotonic()
try:
    while time.monotonic()-start<65:
        time.sleep(4)
        state=json.loads(subprocess.check_output(["bb","terminal","output",terminal,"--json"]))
        if state["status"]=="exited":
            assert time.monotonic()-start>=43, "agent exited before simulated disconnect timeout"
            print("Abandoned UA relay exited in",round(time.monotonic()-start),"seconds")
            break
    else:
        raise AssertionError("Abandoned agent did not exit")
finally:
    subprocess.run(["bb","terminal","close",terminal],capture_output=True)

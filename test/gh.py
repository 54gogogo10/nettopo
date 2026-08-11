import json

d = json.load(open('/tmp/gh.json'))
for r in d.get('items', []):
    print(r['full_name'], '|', (r.get('description') or '')[:90])

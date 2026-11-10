#!/bin/sh
# Run before each release: gives every file a new ?v= number so phones never mix old and new files.
cd "$(dirname "$0")"
N=$(( $(grep -o 'app.js?v=[0-9]*' index.html | grep -o '[0-9]*$') + 1 ))
sed -i -E "s/\?v=[0-9]+/?v=$N/g" index.html app.js recorder.js importer.js renderer.js analyzer.js highlights.js drive.js demo.js rooms.js sw.js
sed -i -E "s/rally-reel-v[0-9]+/rally-reel-v$N/" sw.js
echo "version $N"

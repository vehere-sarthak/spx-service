#!/bin/bash
# Package spx-service as a systemd-managed deb.
# Layout mirrors uiServices/debBuild.sh: bundled Node under node/, app in dist/.
set -e

APP_NAME="spx-service"
DEB_BUILD_FOLDER="./$APP_NAME"
DEB_FILE="./$APP_NAME.deb"

[ -d "$DEB_BUILD_FOLDER" ] && rm -rf "$DEB_BUILD_FOLDER" && echo "Folder deleted: $DEB_BUILD_FOLDER"
[ -f "$DEB_FILE" ] && rm -f "$DEB_FILE" && echo "File deleted: $DEB_FILE"

echo "--------------------------------"
echo "Creating package structure for $APP_NAME..."

mkdir -p "$APP_NAME/DEBIAN"
mkdir -p "$APP_NAME/usr/local/lib/$APP_NAME/node"
mkdir -p "$APP_NAME/usr/local/bin"
mkdir -p "$APP_NAME/lib/systemd/system"

cat <<EOF > "$APP_NAME/DEBIAN/control"
Package: $APP_NAME
Version: 1.0
Section: web
Priority: optional
Architecture: all
Maintainer: Vehere
Description: SpiderX backend API running as a systemd service (HTTPS :8082).
EOF

cat <<EOF > "$APP_NAME/lib/systemd/system/$APP_NAME.service"
[Unit]
Description=SpiderX Service (API)
After=network.target

[Service]
ExecStart=/usr/local/lib/$APP_NAME/node/bin/node /usr/local/lib/$APP_NAME/app.js
Restart=always
User=root
Group=root
Environment=NODE_ENV=production PORT=8082
WorkingDirectory=/usr/local/lib/$APP_NAME
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=$APP_NAME

[Install]
WantedBy=multi-user.target
EOF

cat <<EOF > "$APP_NAME/DEBIAN/postinst"
#!/bin/sh
set -e
echo "Installing $APP_NAME as a service..."

# No config file of its own: spx-service pulls spiderx.yml from spx-ui on :4000.
cp /lib/systemd/system/$APP_NAME.service /etc/systemd/system/$APP_NAME.service
systemctl daemon-reload
systemctl enable $APP_NAME
systemctl restart $APP_NAME

echo "Service installed successfully!"
exit 0
EOF
chmod +x "$APP_NAME/DEBIAN/postinst"

cat <<EOF > "$APP_NAME/DEBIAN/prerm"
#!/bin/sh
set -e
echo "Removing $APP_NAME service..."
systemctl stop $APP_NAME || true
systemctl disable $APP_NAME || true
rm -f /etc/systemd/system/$APP_NAME.service
systemctl daemon-reload
echo "Service removed."
exit 0
EOF
chmod +x "$APP_NAME/DEBIAN/prerm"

cat <<EOF > "$APP_NAME/usr/local/bin/$APP_NAME"
#!/bin/sh
/usr/local/lib/$APP_NAME/node/bin/node /usr/local/lib/$APP_NAME/app.js "\$@"
EOF
chmod +x "$APP_NAME/usr/local/bin/$APP_NAME"

echo "Package structure created"
echo "--------------------------------"

# Bundle Node.js, same as uiServices
NODE_VERSION=$(cat .nvmrc)
echo "Bundling Node.js version: $NODE_VERSION"
NODE_DIST="node-$NODE_VERSION-linux-x64"
NODE_TARBALL="$NODE_DIST.tar.xz"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL"

if [ ! -d node ]; then
  wget "$NODE_URL" -O "$NODE_TARBALL" || {
    echo "ERROR: Failed to download Node.js $NODE_VERSION."; exit 1;
  }
  tar -xJf "$NODE_TARBALL" --strip-components=1 -C "$APP_NAME/usr/local/lib/$APP_NAME/node" || {
    echo "ERROR: Failed to extract Node.js."; exit 1;
  }
  rm "$NODE_TARBALL"
else
  cp -a node/. "$APP_NAME/usr/local/lib/$APP_NAME/node/"
fi
echo "Node.js bundled"

# Build output goes to the package root so app.js sits beside config/
if [ ! -d dist ]; then
  echo "ERROR: dist/ missing — run 'npm run build' first." >&2
  exit 1
fi
cp -r dist/. "$APP_NAME/usr/local/lib/$APP_NAME/"
cp -a node_modules "$APP_NAME/usr/local/lib/$APP_NAME/"
cp package.json package-lock.json "$APP_NAME/usr/local/lib/$APP_NAME/"
[ -f buildInfo.txt ] && cp buildInfo.txt "$APP_NAME/usr/local/lib/$APP_NAME/"
[ -d public ] && cp -a public "$APP_NAME/usr/local/lib/$APP_NAME/"

echo "Creating deb file...."
dpkg-deb --build "$APP_NAME"
rm -r "$APP_NAME/"
echo "Built $DEB_FILE"

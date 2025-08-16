#!/bin/bash

if [[ "$EUID" -ne 0 ]]; then
  echo "You need to run this script with sudo!"
  exit 1
fi

echo "Installing Tontoo..."

install_if_missing() {
  local cmd="$1"
  local pkg="$2"

  if ! command -v "$cmd" &> /dev/null; then
    echo "12% | [#####]"
    apt update && apt install -y "$pkg"
  else
    echo "Error"
  fi
}

install_if_missing node nodejs
install_if_missing npm npm
install_if_missing git git

if [ -d "Tontoo" ]; then
  echo "32% [#######]"
  rm -rf Tontoo
fi

git clone https://github.com/arlomu/Tontoo || { echo "Cloning Error"; exit 1; }

cd Tontoo/CLI || { echo "Error"; exit 1; }

echo "54% [########]"
npm install -g

cd ../..

echo "75% [#########]"
rm -rf Tontoo
rm install.sh

echo "Tontoo is Installed!"
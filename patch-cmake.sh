#!/bin/bash
# Wait for npm to download the package
sleep 2

# Patch the main CMakeLists.txt
if [ -f node_modules/@hanazuki/node-jsonnet/CMakeLists.txt ]; then
  sed -i '' 's/cmake_minimum_required(VERSION [0-9.]*)/cmake_minimum_required(VERSION 3.10)/' \
    node_modules/@hanazuki/node-jsonnet/CMakeLists.txt
fi

# Patch the jsonnet third-party CMakeLists.txt
if [ -f node_modules/@hanazuki/node-jsonnet/third_party/jsonnet/CMakeLists.txt ]; then
  sed -i '' 's/cmake_minimum_required(VERSION [0-9.]*)/cmake_minimum_required(VERSION 3.10)/' \
    node_modules/@hanazuki/node-jsonnet/third_party/jsonnet/CMakeLists.txt
fi

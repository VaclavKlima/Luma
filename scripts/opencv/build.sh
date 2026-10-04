#!/bin/bash
set -eu
# Run inside emscripten/emsdk:4.0.20 with the repository mounted at /work.
cd /work
mkdir -p artifacts/opencv-build
cd artifacts/opencv-build
curl --fail -L https://github.com/opencv/opencv/archive/refs/tags/4.13.0.tar.gz -o source.tar.gz
printf '%s\n' '1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d  source.tar.gz' | sha256sum -c -
tar -xzf source.tar.gz
emcmake cmake -S opencv-4.13.0 -B build \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_STANDARD=17 \
  -DCMAKE_CXX_FLAGS='-fexceptions -msimd128 -Wno-deprecated-declarations' -DCMAKE_C_FLAGS='-msimd128' -DBUILD_LIST=core,imgproc,features2d,calib3d,video \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
  -DBUILD_opencv_apps=OFF -DBUILD_opencv_gapi=OFF -DBUILD_opencv_dnn=OFF -DBUILD_JAVA=OFF \
  -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_OPENCL=OFF -DWITH_PTHREADS_PF=OFF \
  -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_PROTOBUF=OFF \
  -DBUILD_ZLIB=OFF -DWITH_ZLIB=OFF -DWITH_PNG=OFF -DWITH_JPEG=OFF -DWITH_TIFF=OFF -DWITH_OPENEXR=OFF
cmake --build build -j 8
bash /work/scripts/opencv/link.sh

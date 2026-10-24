#!/bin/zsh
cd "${0:A:h}"
npm start &
server_pid=$!
sleep 1
open "http://127.0.0.1:4173"
wait $server_pid

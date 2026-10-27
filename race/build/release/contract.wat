(module
 (type $0 (func (param i32 i32)))
 (type $1 (func (param i32 i32) (result i32)))
 (type $2 (func (param i32) (result i32)))
 (type $3 (func (param i32 i32 i32) (result i32)))
 (type $4 (func (result i32)))
 (type $5 (func (param i32 i32 i32)))
 (type $6 (func (param i32)))
 (type $7 (func (param i32 i64)))
 (type $8 (func))
 (type $9 (func (param i64 i32) (result i32)))
 (type $10 (func (param i32) (result i64)))
 (type $11 (func (param i32 i32 i32 i32 i32 i32) (result i32)))
 (type $12 (func (param i32 i64 i32) (result i32)))
 (type $13 (func (param i64) (result i32)))
 (type $14 (func (param i32 i32 i32 i32)))
 (import "env" "invoke_system_call" (func $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall (param i32 i32 i32 i32 i32 i32) (result i32)))
 (global $~lib/rt/stub/offset (mut i32) (i32.const 0))
 (global $~lib/as-proto/assembly/Protobuf/WRITER (mut i32) (i32.const 0))
 (global $~lib/as-proto/assembly/Protobuf/READER (mut i32) (i32.const 0))
 (global $~argumentsLength (mut i32) (i32.const 0))
 (global $~lib/@koinos/sdk-as/assembly/util/storage/DEFAULT_KEY (mut i32) (i32.const 0))
 (global $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE (mut i32) (i32.const 0))
 (global $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER (mut i32) (i32.const 0))
 (global $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES (mut i32) (i32.const 0))
 (global $~lib/@koinos/sdk-as/assembly/systemCalls/System.cacheGetArguments (mut i32) (i32.const 0))
 (global $~started (mut i32) (i32.const 0))
 (memory $0 1)
 (data $0 (i32.const 1036) "\1c")
 (data $0.1 (i32.const 1048) "\01")
 (data $1 (i32.const 1068) "\1c")
 (data $1.1 (i32.const 1080) "\01")
 (data $2 (i32.const 1100) "\1c")
 (data $2.1 (i32.const 1112) "\01")
 (data $3 (i32.const 1132) "\1c")
 (data $3.1 (i32.const 1144) "\02")
 (data $4 (i32.const 1164) "<")
 (data $4.1 (i32.const 1176) "\02\00\00\00,\00\00\00R\00A\00C\00E\00:\00 \00p\00i\00c\00k\00s\00 \00a\00r\00e\00 \00c\00l\00o\00s\00e\00d")
 (data $5 (i32.const 1228) "l")
 (data $5.1 (i32.const 1240) "\02\00\00\00Z\00\00\00R\00A\00C\00E\00:\00 \00t\00h\00i\00s\00 \00r\00a\00c\00e\00 \00h\00a\00s\00 \00s\00t\00a\00r\00t\00e\00d\00;\00 \00p\00i\00c\00k\00s\00 \00a\00r\00e\00 \00l\00o\00c\00k\00e\00d")
 (data $6 (i32.const 1340) "l")
 (data $6.1 (i32.const 1352) "\02\00\00\00N\00\00\00R\00A\00C\00E\00:\00 \00p\00i\00c\00k\00s\00 \00o\00p\00e\00n\00 \002\004\00 \00h\00o\00u\00r\00s\00 \00b\00e\00f\00o\00r\00e\00 \00a\00 \00r\00a\00c\00e")
 (data $7 (i32.const 1452) "\\")
 (data $7.1 (i32.const 1464) "\02\00\00\00>\00\00\00R\00A\00C\00E\00:\00 \00t\00o\00d\00a\00y\00\'\00s\00 \00p\00i\00c\00k\00s\00 \00a\00r\00e\00 \00u\00s\00e\00d\00 \00u\00p")
 (data $8 (i32.const 1548) "\\")
 (data $8.1 (i32.const 1560) "\02\00\00\00>\00\00\00R\00A\00C\00E\00:\00 \00t\00h\00a\00t\00 \00i\00s\00 \00a\00l\00r\00e\00a\00d\00y\00 \00y\00o\00u\00r\00 \00p\00i\00c\00k")
 (data $9 (i32.const 1644) "L")
 (data $9.1 (i32.const 1656) "\02\00\00\004\00\00\00R\00A\00C\00E\00:\00 \00t\00h\00e\00 \00p\00l\00a\00y\00e\00r\00 \00m\00u\00s\00t\00 \00s\00i\00g\00n")
 (data $10 (i32.const 1724) "|")
 (data $10.1 (i32.const 1736) "\02\00\00\00^\00\00\00U\00n\00e\00x\00p\00e\00c\00t\00e\00d\00 \00\'\00n\00u\00l\00l\00\'\00 \00(\00n\00o\00t\00 \00a\00s\00s\00i\00g\00n\00e\00d\00 \00o\00r\00 \00f\00a\00i\00l\00e\00d\00 \00c\00a\00s\00t\00)")
 (data $11 (i32.const 1852) "\1c")
 (data $11.1 (i32.const 1864) "\10\00\00\00\08\00\00\00\01")
 (data $12 (i32.const 1884) "\1c")
 (data $12.1 (i32.const 1896) "\12\00\00\00\08\00\00\00\02")
 (data $13 (i32.const 1916) "\1c")
 (data $13.1 (i32.const 1928) "\15\00\00\00\08\00\00\00\03")
 (data $14 (i32.const 1948) "\1c")
 (data $14.1 (i32.const 1960) "\18\00\00\00\08\00\00\00\04")
 (data $15 (i32.const 1980) "\1c")
 (data $15.1 (i32.const 1992) "\1f\00\00\00\08\00\00\00\05")
 (data $16 (i32.const 2012) "\1c")
 (data $16.1 (i32.const 2024) "!\00\00\00\08\00\00\00\06")
 (data $17 (i32.const 2044) "\1c")
 (data $17.1 (i32.const 2056) "\"\00\00\00\08\00\00\00\07")
 (data $18 (i32.const 2076) "\1c")
 (data $18.1 (i32.const 2088) "#\00\00\00\08\00\00\00\08")
 (data $19 (i32.const 2108) "\1c")
 (data $19.1 (i32.const 2120) "$\00\00\00\08\00\00\00\t")
 (data $20 (i32.const 2140) "\1c")
 (data $20.1 (i32.const 2152) "%\00\00\00\08\00\00\00\n")
 (data $21 (i32.const 2172) "\1c")
 (data $21.1 (i32.const 2184) "&\00\00\00\08\00\00\00\0b")
 (data $22 (i32.const 2204) "\1c")
 (data $22.1 (i32.const 2216) "\'\00\00\00\08\00\00\00\0c")
 (data $23 (i32.const 2236) "\1c")
 (data $23.1 (i32.const 2248) "(\00\00\00\08\00\00\00\r")
 (data $24 (i32.const 2268) "\1c")
 (data $24.1 (i32.const 2280) ")\00\00\00\08\00\00\00\0e")
 (data $25 (i32.const 2300) "\1c")
 (data $25.1 (i32.const 2312) "*\00\00\00\08\00\00\00\0f")
 (data $26 (i32.const 2332) "\1c")
 (data $26.1 (i32.const 2344) ",\00\00\00\08\00\00\00\10")
 (data $27 (i32.const 2364) "\1c")
 (data $27.1 (i32.const 2376) ".\00\00\00\08\00\00\00\11")
 (data $28 (i32.const 2396) "\1c")
 (data $28.1 (i32.const 2408) "1\00\00\00\08\00\00\00\12")
 (data $29 (i32.const 2428) "\1c")
 (data $29.1 (i32.const 2440) "3\00\00\00\08\00\00\00\13")
 (data $30 (i32.const 2460) "\1c")
 (data $30.1 (i32.const 2472) "5\00\00\00\08\00\00\00\14")
 (data $31 (i32.const 2492) "<")
 (data $31.1 (i32.const 2504) "\02\00\00\00(\00\00\00R\00A\00C\00E\00:\00 \00i\00n\00v\00a\00l\00i\00d\00 \00p\00l\00a\00y\00e\00r")
 (data $32 (i32.const 2556) "<")
 (data $32.1 (i32.const 2568) "\02\00\00\00&\00\00\00R\00A\00C\00E\00:\00 \00i\00n\00v\00a\00l\00i\00d\00 \00h\00o\00r\00s\00e")
 (data $33 (i32.const 2620) "\1c")
 (data $33.1 (i32.const 2632) "7\00\00\00\08\00\00\00\15")
 (data $34 (i32.const 2652) "\1c")
 (data $34.1 (i32.const 2664) "8\00\00\00\08\00\00\00\16")
 (data $35 (i32.const 2684) "\1c")
 (data $35.1 (i32.const 2696) ";\00\00\00\08\00\00\00\17")
 (data $36 (i32.const 2716) "\1c")
 (data $36.1 (i32.const 2728) "=\00\00\00\08\00\00\00\18")
 (data $37 (i32.const 2748) "\1c")
 (data $37.1 (i32.const 2760) "?\00\00\00\08\00\00\00\19")
 (data $38 (i32.const 2780) "<")
 (data $38.1 (i32.const 2792) "\02\00\00\00\1e\00\00\00r\00a\00c\00e\00.\00p\00i\00c\00k\00_\00e\00v\00e\00n\00t")
 (data $39 (i32.const 2844) "\1c")
 (data $39.1 (i32.const 2856) "B\00\00\00\08\00\00\00\1a")
 (data $40 (i32.const 2876) "\1c")
 (data $40.1 (i32.const 2888) "D\00\00\00\08\00\00\00\1b")
 (data $41 (i32.const 2908) "\1c")
 (data $41.1 (i32.const 2920) "E\00\00\00\08\00\00\00\1c")
 (data $42 (i32.const 2940) "\1c")
 (data $42.1 (i32.const 2952) "G\00\00\00\08\00\00\00\1d")
 (data $43 (i32.const 2972) "\1c")
 (data $43.1 (i32.const 2984) "I\00\00\00\08\00\00\00\1e")
 (data $44 (i32.const 3004) "\1c")
 (data $44.1 (i32.const 3016) "K\00\00\00\08\00\00\00\1f")
 (data $45 (i32.const 3036) "\1c")
 (data $45.1 (i32.const 3048) "\01")
 (data $46 (i32.const 3068) "\1c")
 (data $46.1 (i32.const 3080) "Q\00\00\00\08\00\00\00 ")
 (data $47 (i32.const 3100) "\1c")
 (data $47.1 (i32.const 3112) "S\00\00\00\08\00\00\00!")
 (data $48 (i32.const 3132) "\1c")
 (data $48.1 (i32.const 3144) "T\00\00\00\08\00\00\00\"")
 (data $49 (i32.const 3164) "\1c")
 (data $49.1 (i32.const 3176) "V\00\00\00\08\00\00\00#")
 (data $50 (i32.const 3196) "\1c")
 (data $50.1 (i32.const 3208) "W\00\00\00\08\00\00\00$")
 (data $51 (i32.const 3228) "\1c")
 (data $51.1 (i32.const 3240) "X\00\00\00\08\00\00\00%")
 (data $52 (i32.const 3260) "\1c")
 (data $52.1 (i32.const 3272) "Z\00\00\00\08\00\00\00&")
 (data $53 (i32.const 3292) "L")
 (data $53.1 (i32.const 3304) "\02\00\00\006\00\00\00R\00A\00C\00E\00:\00 \00n\00e\00e\00d\00s\00 \00t\00h\00e\00 \00o\00w\00n\00e\00r\00\'\00s\00 \00k\00e\00y")
 (data $54 (i32.const 3372) "<")
 (data $54.1 (i32.const 3384) "\02\00\00\00(\00\00\00R\00A\00C\00E\00:\00 \00c\00o\00n\00f\00i\00g\00 \00m\00i\00s\00s\00i\00n\00g")
 (data $55 (i32.const 3436) "<")
 (data $55.1 (i32.const 3448) "\02\00\00\00&\00\00\00R\00A\00C\00E\00:\00 \00i\00n\00v\00a\00l\00i\00d\00 \00o\00w\00n\00e\00r")
 (data $56 (i32.const 3500) "|")
 (data $56.1 (i32.const 3512) "\02\00\00\00f\00\00\00R\00A\00C\00E\00:\00 \00t\00h\00e\00 \00o\00w\00n\00e\00r\00 \00m\00u\00s\00t\00 \00b\00e\00 \00a\00 \00w\00a\00l\00l\00e\00t\00,\00 \00n\00o\00t\00 \00t\00h\00i\00s\00 \00c\00o\00n\00t\00r\00a\00c\00t")
 (data $57 (i32.const 3628) "\\")
 (data $57.1 (i32.const 3640) "\02\00\00\00F\00\00\00R\00A\00C\00E\00:\00 \00p\00i\00c\00k\00s\00 \00p\00e\00r\00 \00d\00a\00y\00 \00m\00u\00s\00t\00 \00b\00e\00 \001\00 \00t\00o\00 \002\000")
 (data $58 (i32.const 3724) "<")
 (data $58.1 (i32.const 3736) "\02\00\00\00\"\00\00\00r\00a\00c\00e\00.\00c\00o\00n\00f\00i\00g\00_\00e\00v\00e\00n\00t")
 (data $59 (i32.const 3788) "\1c")
 (data $59.1 (i32.const 3800) "\\\00\00\00\08\00\00\00\'")
 (table $0 40 40 funcref)
 (elem $0 (i32.const 1) $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.exit_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_result.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_contract_id_result.decode $assembly/proto/race/race.config.decode $assembly/proto/race/race.config.encode $assembly/Race/Race#constructor~anonymous|0 $assembly/proto/race/race.pick_object.decode $assembly/proto/race/race.pick_object.encode $assembly/Race/Race#constructor~anonymous|1 $assembly/proto/race/race.day_count.decode $assembly/proto/race/race.day_count.encode $assembly/Race/Race#constructor~anonymous|2 $assembly/proto/race/race.pick_arguments.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_result.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_result.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.check_authority_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.check_authority_result.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_head_info_result.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.put_object_arguments.encode $assembly/proto/race/race.pick_event.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.event_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments.encode $assembly/proto/race/race.get_pick_arguments.decode $assembly/proto/race/race.get_pick_result.encode $assembly/proto/race/race.list_picks_arguments.decode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_arguments.encode $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_next_object_result.decode $assembly/proto/race/race.list_picks_result.encode $assembly/proto/race/race.get_usage_arguments.decode $assembly/proto/race/race.get_usage_result.encode $assembly/proto/race/race.get_config_arguments.decode $assembly/proto/race/race.set_config_arguments.decode $assembly/proto/race/race.config_event.encode)
 (export "main" (func $assembly/index/main))
 (export "memory" (memory $0))
 (export "_start" (func $~start))
 (func $~lib/rt/stub/maybeGrowMemory (param $0 i32)
  (local $1 i32)
  (local $2 i32)
  memory.size
  local.tee $1
  i32.const 16
  i32.shl
  i32.const 15
  i32.add
  i32.const -16
  i32.and
  local.tee $2
  local.get $0
  i32.lt_u
  if
   local.get $1
   local.get $0
   local.get $2
   i32.sub
   i32.const 65535
   i32.add
   i32.const -65536
   i32.and
   i32.const 16
   i32.shr_u
   local.tee $2
   local.get $1
   local.get $2
   i32.gt_s
   select
   memory.grow
   i32.const 0
   i32.lt_s
   if
    local.get $2
    memory.grow
    i32.const 0
    i32.lt_s
    if
     unreachable
    end
   end
  end
  local.get $0
  global.set $~lib/rt/stub/offset
 )
 (func $~lib/rt/common/BLOCK#set:mmInfo (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store
 )
 (func $~lib/rt/stub/__alloc (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  local.get $0
  i32.const 1073741820
  i32.gt_u
  if
   unreachable
  end
  global.get $~lib/rt/stub/offset
  local.set $1
  global.get $~lib/rt/stub/offset
  i32.const 4
  i32.add
  local.tee $2
  local.get $0
  i32.const 19
  i32.add
  i32.const -16
  i32.and
  i32.const 4
  i32.sub
  local.tee $0
  i32.add
  call $~lib/rt/stub/maybeGrowMemory
  local.get $1
  local.get $0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
 )
 (func $~lib/rt/common/OBJECT#set:gcInfo (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=4
 )
 (func $~lib/rt/common/OBJECT#set:gcInfo2 (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=8
 )
 (func $~lib/rt/common/OBJECT#set:rtId (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=12
 )
 (func $~lib/rt/common/OBJECT#set:rtSize (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=16
 )
 (func $~lib/rt/stub/__new (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $0
  i32.const 1073741804
  i32.gt_u
  if
   unreachable
  end
  local.get $0
  i32.const 16
  i32.add
  call $~lib/rt/stub/__alloc
  local.tee $3
  i32.const 4
  i32.sub
  local.tee $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  local.get $1
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $2
  local.get $0
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $3
  i32.const 16
  i32.add
 )
 (func $~lib/object/Object#constructor (param $0 i32) (result i32)
  local.get $0
  if (result i32)
   local.get $0
  else
   i32.const 0
   i32.const 0
   call $~lib/rt/stub/__new
  end
 )
 (func $~lib/as-proto/assembly/Writer/Writer#constructor (param $0 i32) (result i32)
  local.get $0
  if (result i32)
   local.get $0
  else
   i32.const 0
   i32.const 5
   call $~lib/rt/stub/__new
  end
  call $~lib/object/Object#constructor
 )
 (func $~lib/memory/memory.copy (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  (local $4 i32)
  block $~lib/util/memory/memmove|inlined.0
   local.get $2
   local.set $4
   local.get $0
   local.get $1
   i32.eq
   br_if $~lib/util/memory/memmove|inlined.0
   local.get $0
   local.get $1
   i32.lt_u
   if
    loop $while-continue|0
     local.get $4
     if
      local.get $0
      local.tee $2
      i32.const 1
      i32.add
      local.set $0
      local.get $1
      local.tee $3
      i32.const 1
      i32.add
      local.set $1
      local.get $2
      local.get $3
      i32.load8_u
      i32.store8
      local.get $4
      i32.const 1
      i32.sub
      local.set $4
      br $while-continue|0
     end
    end
   else
    loop $while-continue|1
     local.get $4
     if
      local.get $0
      local.get $4
      i32.const 1
      i32.sub
      local.tee $4
      i32.add
      local.get $1
      local.get $4
      i32.add
      i32.load8_u
      i32.store8
      br $while-continue|1
     end
    end
   end
  end
 )
 (func $~lib/rt/__newArray (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  i32.const 2
  i32.shl
  local.tee $4
  i32.const 1
  call $~lib/rt/stub/__new
  local.set $3
  local.get $2
  if
   local.get $3
   local.get $2
   local.get $4
   call $~lib/memory/memory.copy
  end
  i32.const 16
  local.get $1
  call $~lib/rt/stub/__new
  local.tee $1
  local.get $3
  i32.store
  local.get $1
  local.get $3
  i32.store offset=4
  local.get $1
  local.get $4
  i32.store offset=8
  local.get $1
  local.get $0
  i32.store offset=12
  local.get $1
 )
 (func $~lib/memory/memory.fill (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $1
  local.set $2
  loop $while-continue|0
   local.get $2
   if
    local.get $0
    local.tee $1
    i32.const 1
    i32.add
    local.set $0
    local.get $1
    i32.const 0
    i32.store8
    local.get $2
    i32.const 1
    i32.sub
    local.set $2
    br $while-continue|0
   end
  end
 )
 (func $~lib/arraybuffer/ArrayBufferView#constructor (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  local.get $0
  i32.eqz
  if
   i32.const 12
   i32.const 3
   call $~lib/rt/stub/__new
   local.set $0
  end
  local.get $0
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  i32.const 1073741820
  local.get $2
  i32.shr_u
  i32.gt_u
  if
   unreachable
  end
  local.get $1
  local.get $2
  i32.shl
  local.tee $1
  i32.const 1
  call $~lib/rt/stub/__new
  local.tee $2
  local.get $1
  call $~lib/memory/memory.fill
  local.get $0
  local.get $2
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  local.get $2
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $0
  local.get $1
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $0
 )
 (func $~lib/typedarray/Uint8Array#constructor (param $0 i32) (result i32)
  i32.const 12
  i32.const 9
  call $~lib/rt/stub/__new
  local.get $0
  i32.const 0
  call $~lib/arraybuffer/ArrayBufferView#constructor
 )
 (func $start:~lib/as-proto/index
  (local $0 i32)
  (local $1 i32)
  i32.const 3820
  global.set $~lib/rt/stub/offset
  i32.const 16
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $0
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
  call $~lib/as-proto/assembly/Writer/Writer#constructor
  local.set $0
  i32.const 16
  i32.const 6
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $1
  call $~lib/as-proto/assembly/Writer/Writer#constructor
  local.tee $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  i32.const 0
  i32.const 7
  i32.const 1056
  call $~lib/rt/__newArray
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $1
  i32.const 0
  i32.const 8
  i32.const 1088
  call $~lib/rt/__newArray
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  i32.const 0
  i32.const 8
  i32.const 1120
  call $~lib/rt/__newArray
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
  local.get $1
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  local.get $0
  i32.load
  i32.load
  call $~lib/typedarray/Uint8Array#constructor
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $0
  local.get $0
  i32.load offset=8
  i32.load offset=4
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
  global.set $~lib/as-proto/assembly/Protobuf/WRITER
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  local.set $0
  i32.const 12
  i32.const 10
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  if (result i32)
   local.get $1
  else
   i32.const 8
   i32.const 11
   call $~lib/rt/stub/__new
  end
  call $~lib/object/Object#constructor
  local.tee $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $1
  local.get $0
  i32.load offset=4
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  i32.add
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $1
  local.get $0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  global.set $~lib/as-proto/assembly/Protobuf/READER
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store8
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#constructor (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  i32.const 12
  i32.const 12
  call $~lib/rt/stub/__new
  local.tee $3
  i32.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
  local.get $3
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $3
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $3
  local.get $0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
  local.get $3
  local.get $1
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $3
  local.get $2
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $3
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments.encode (param $0 i32) (param $1 i32)
 )
 (func $~lib/rt/stub/__renew (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  local.get $1
  i32.const 1073741804
  i32.gt_u
  if
   unreachable
  end
  local.get $0
  i32.const 16
  i32.sub
  local.tee $0
  i32.const 15
  i32.and
  i32.const 1
  local.get $0
  select
  if
   unreachable
  end
  global.get $~lib/rt/stub/offset
  local.get $0
  i32.const 4
  i32.sub
  local.tee $4
  i32.load
  local.tee $3
  local.get $0
  i32.add
  i32.eq
  local.set $2
  local.get $1
  i32.const 16
  i32.add
  local.tee $6
  i32.const 19
  i32.add
  i32.const -16
  i32.and
  i32.const 4
  i32.sub
  local.set $5
  local.get $3
  local.get $6
  i32.lt_u
  if
   local.get $2
   if
    local.get $6
    i32.const 1073741820
    i32.gt_u
    if
     unreachable
    end
    local.get $0
    local.get $5
    i32.add
    call $~lib/rt/stub/maybeGrowMemory
    local.get $4
    local.get $5
    call $~lib/rt/common/BLOCK#set:mmInfo
   else
    local.get $5
    local.get $3
    i32.const 1
    i32.shl
    local.tee $2
    local.get $2
    local.get $5
    i32.lt_u
    select
    call $~lib/rt/stub/__alloc
    local.tee $2
    local.get $0
    local.get $3
    call $~lib/memory/memory.copy
    local.get $2
    local.set $0
   end
  else
   local.get $2
   if
    local.get $0
    local.get $5
    i32.add
    global.set $~lib/rt/stub/offset
    local.get $4
    local.get $5
    call $~lib/rt/common/BLOCK#set:mmInfo
   end
  end
  local.get $0
  i32.const 4
  i32.sub
  local.get $1
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $0
  i32.const 16
  i32.add
 )
 (func $~lib/array/ensureCapacity (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $1
  local.get $0
  i32.load offset=8
  local.tee $3
  i32.const 2
  i32.shr_u
  i32.gt_u
  if
   local.get $1
   i32.const 268435455
   i32.gt_u
   if
    unreachable
   end
   i32.const 8
   local.get $1
   local.get $1
   i32.const 8
   i32.le_u
   select
   i32.const 2
   i32.shl
   local.set $1
   local.get $2
   if
    i32.const 1073741820
    local.get $3
    i32.const 1
    i32.shl
    local.tee $2
    local.get $2
    i32.const 1073741820
    i32.ge_u
    select
    local.tee $2
    local.get $1
    local.get $1
    local.get $2
    i32.lt_u
    select
    local.set $1
   end
   local.get $3
   local.get $0
   i32.load
   local.tee $4
   local.get $1
   call $~lib/rt/stub/__renew
   local.tee $2
   i32.add
   local.get $1
   local.get $3
   i32.sub
   call $~lib/memory/memory.fill
   local.get $2
   local.get $4
   i32.ne
   if
    local.get $0
    local.get $2
    i32.store
    local.get $0
    local.get $2
    i32.store offset=4
   end
   local.get $0
   local.get $1
   i32.store offset=8
  end
 )
 (func $~lib/array/Array<u32>#set:length (param $0 i32)
  local.get $0
  i32.const 0
  i32.const 0
  call $~lib/array/ensureCapacity
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
 )
 (func $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments> (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  global.get $~lib/as-proto/assembly/Protobuf/WRITER
  i32.load
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.load offset=4
  call $~lib/array/Array<u32>#set:length
  local.get $2
  i32.load offset=8
  call $~lib/array/Array<u32>#set:length
  local.get $2
  i32.load offset=12
  call $~lib/array/Array<u32>#set:length
  global.get $~lib/as-proto/assembly/Protobuf/WRITER
  i32.load
  local.set $2
  i32.const 2
  global.set $~argumentsLength
  local.get $0
  local.get $2
  local.get $1
  i32.load
  call_indirect (type $0)
  global.get $~lib/as-proto/assembly/Protobuf/WRITER
  local.tee $2
  local.get $2
  i32.load
  i32.load
  call $~lib/typedarray/Uint8Array#constructor
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  local.get $2
  i32.load offset=8
  i32.load offset=4
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  i32.const 2
  global.set $~argumentsLength
  local.get $0
  global.get $~lib/as-proto/assembly/Protobuf/WRITER
  local.get $1
  i32.load
  call_indirect (type $0)
  global.get $~lib/as-proto/assembly/Protobuf/WRITER
  i32.load offset=8
 )
 (func $~lib/typedarray/Uint32Array#__get (param $0 i32) (result i32)
  local.get $0
  i32.load offset=8
  i32.const 2
  i32.shr_u
  i32.eqz
  if
   unreachable
  end
  local.get $0
  i32.load offset=4
  i32.load
 )
 (func $~lib/typedarray/Uint8Array#slice (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  local.get $0
  i32.load offset=8
  local.set $3
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $1
   local.get $3
   i32.add
   local.tee $1
   i32.const 0
   local.get $1
   i32.const 0
   i32.gt_s
   select
  else
   local.get $1
   local.get $3
   local.get $1
   local.get $3
   i32.lt_s
   select
  end
  local.set $1
  local.get $2
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $2
   local.get $3
   i32.add
   local.tee $2
   i32.const 0
   local.get $2
   i32.const 0
   i32.gt_s
   select
  else
   local.get $2
   local.get $3
   local.get $2
   local.get $3
   i32.lt_s
   select
  end
  local.get $1
  i32.sub
  local.tee $2
  i32.const 0
  local.get $2
  i32.const 0
  i32.gt_s
  select
  local.tee $2
  call $~lib/typedarray/Uint8Array#constructor
  local.tee $3
  i32.load offset=4
  local.get $0
  i32.load offset=4
  local.get $1
  i32.add
  local.get $2
  call $~lib/memory/memory.copy
  local.get $3
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data#constructor (param $0 i32) (result i32)
  (local $1 i32)
  i32.const 4
  i32.const 17
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  local.get $0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $2
  i32.const 1152
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data#constructor
  local.set $1
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $2
   i32.lt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $3
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     block $__inlined_func$~lib/as-proto/assembly/Reader/Reader#string@override$42
      local.get $0
      i32.const 8
      i32.sub
      i32.load
      i32.const 10
      i32.eq
      if
       local.get $0
       call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#bytes
       local.tee $3
       i32.load offset=4
       local.get $3
       i32.load offset=8
       i32.const 0
       call $~lib/string/String.UTF8.decodeUnsafe
       local.set $3
       br $__inlined_func$~lib/as-proto/assembly/Reader/Reader#string@override$42
      end
      unreachable
     end
     local.get $1
     local.get $3
     call $~lib/rt/common/BLOCK#set:mmInfo
     br $while-continue|0
    end
    local.get $0
    local.get $3
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $1
 )
 (func $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data> (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  global.get $~lib/as-proto/assembly/Protobuf/READER
  local.tee $3
  local.get $0
  i32.load offset=4
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  i32.add
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $3
  local.get $0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  i32.const 2
  global.set $~argumentsLength
  global.get $~lib/as-proto/assembly/Protobuf/READER
  local.get $2
  local.get $1
  i32.load
  call_indirect (type $1)
 )
 (func $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  block $1of1
   block $0of1
    block $outOfRange
     global.get $~argumentsLength
     i32.const 2
     i32.sub
     br_table $0of1 $1of1 $outOfRange
    end
    unreachable
   end
   i32.const -1
   local.set $2
  end
  local.get $0
  local.get $1
  local.get $2
  call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
 )
 (func $~lib/string/String#get:length (param $0 i32) (result i32)
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
 )
 (func $~lib/string/String.UTF8.byteLength (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.add
  local.set $4
  local.get $1
  i32.const 0
  i32.ne
  local.set $2
  loop $while-continue|0
   local.get $0
   local.get $4
   i32.lt_u
   if
    block $while-break|0
     local.get $0
     i32.load16_u
     local.tee $3
     i32.const 128
     i32.lt_u
     if (result i32)
      local.get $1
      local.get $3
      i32.eqz
      i32.and
      br_if $while-break|0
      local.get $2
      i32.const 1
      i32.add
     else
      local.get $3
      i32.const 2048
      i32.lt_u
      if (result i32)
       local.get $2
       i32.const 2
       i32.add
      else
       local.get $3
       i32.const 64512
       i32.and
       i32.const 55296
       i32.eq
       local.get $0
       i32.const 2
       i32.add
       local.get $4
       i32.lt_u
       i32.and
       if
        local.get $0
        i32.load16_u offset=2
        i32.const 64512
        i32.and
        i32.const 56320
        i32.eq
        if
         local.get $2
         i32.const 4
         i32.add
         local.set $2
         local.get $0
         i32.const 4
         i32.add
         local.set $0
         br $while-continue|0
        end
       end
       local.get $2
       i32.const 3
       i32.add
      end
     end
     local.set $2
     local.get $0
     i32.const 2
     i32.add
     local.set $0
     br $while-continue|0
    end
   end
  end
  local.get $2
 )
 (func $~lib/string/String.UTF8.encodeUnsafe (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  local.get $1
  i32.const 1
  i32.shl
  i32.add
  local.set $3
  local.get $2
  local.set $1
  loop $while-continue|0
   local.get $0
   local.get $3
   i32.lt_u
   if
    local.get $0
    i32.load16_u
    local.tee $2
    i32.const 128
    i32.lt_u
    if (result i32)
     local.get $1
     local.get $2
     i32.store8
     local.get $1
     i32.const 1
     i32.add
    else
     local.get $2
     i32.const 2048
     i32.lt_u
     if (result i32)
      local.get $1
      local.get $2
      i32.const 6
      i32.shr_u
      i32.const 192
      i32.or
      local.get $2
      i32.const 63
      i32.and
      i32.const 128
      i32.or
      i32.const 8
      i32.shl
      i32.or
      i32.store16
      local.get $1
      i32.const 2
      i32.add
     else
      local.get $2
      i32.const 56320
      i32.lt_u
      local.get $0
      i32.const 2
      i32.add
      local.get $3
      i32.lt_u
      i32.and
      local.get $2
      i32.const 63488
      i32.and
      i32.const 55296
      i32.eq
      i32.and
      if
       local.get $0
       i32.load16_u offset=2
       local.tee $4
       i32.const 64512
       i32.and
       i32.const 56320
       i32.eq
       if
        local.get $1
        local.get $2
        i32.const 1023
        i32.and
        i32.const 10
        i32.shl
        i32.const 65536
        i32.add
        local.get $4
        i32.const 1023
        i32.and
        i32.or
        local.tee $2
        i32.const 63
        i32.and
        i32.const 128
        i32.or
        i32.const 24
        i32.shl
        local.get $2
        i32.const 6
        i32.shr_u
        i32.const 63
        i32.and
        i32.const 128
        i32.or
        i32.const 16
        i32.shl
        i32.or
        local.get $2
        i32.const 12
        i32.shr_u
        i32.const 63
        i32.and
        i32.const 128
        i32.or
        i32.const 8
        i32.shl
        i32.or
        local.get $2
        i32.const 18
        i32.shr_u
        i32.const 240
        i32.or
        i32.or
        i32.store
        local.get $1
        i32.const 4
        i32.add
        local.set $1
        local.get $0
        i32.const 4
        i32.add
        local.set $0
        br $while-continue|0
       end
      end
      local.get $1
      local.get $2
      i32.const 12
      i32.shr_u
      i32.const 224
      i32.or
      local.get $2
      i32.const 6
      i32.shr_u
      i32.const 63
      i32.and
      i32.const 128
      i32.or
      i32.const 8
      i32.shl
      i32.or
      i32.store16
      local.get $1
      local.get $2
      i32.const 63
      i32.and
      i32.const 128
      i32.or
      i32.store8 offset=2
      local.get $1
      i32.const 3
      i32.add
     end
    end
    local.set $1
    local.get $0
    i32.const 2
    i32.add
    local.set $0
    br $while-continue|0
   end
  end
 )
 (func $~lib/@koinos/sdk-as/assembly/util/stringBytes/StringBytes.stringToBytes (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  i32.const 1
  call $~lib/string/String.UTF8.byteLength
  i32.const 1
  i32.sub
  local.tee $2
  call $~lib/typedarray/Uint8Array#constructor
  local.tee $3
  i32.load offset=4
  local.set $4
  i32.const 2
  global.set $~argumentsLength
  local.get $0
  i32.const 0
  call $~lib/string/String.UTF8.byteLength
  i32.const 1
  call $~lib/rt/stub/__new
  local.set $1
  local.get $0
  local.get $0
  call $~lib/string/String#get:length
  local.get $1
  call $~lib/string/String.UTF8.encodeUnsafe
  local.get $4
  local.get $1
  local.get $2
  call $~lib/memory/memory.copy
  local.get $3
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.result#constructor (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  i32.const 8
  i32.const 20
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  local.get $0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  local.get $1
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
 )
 (func $~lib/arraybuffer/ArrayBufferView#get:byteOffset (param $0 i32) (result i32)
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load
  i32.sub
 )
 (func $~lib/arraybuffer/ArrayBuffer#get:byteLength (param $0 i32) (result i32)
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
 )
 (func $~lib/string/String.UTF8.decodeUnsafe (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  local.get $0
  local.get $1
  i32.add
  local.tee $4
  local.get $0
  i32.lt_u
  if
   unreachable
  end
  local.get $1
  i32.const 1
  i32.shl
  i32.const 2
  call $~lib/rt/stub/__new
  local.tee $5
  local.set $1
  loop $while-continue|0
   local.get $0
   local.get $4
   i32.lt_u
   if
    block $while-break|0
     local.get $0
     i32.load8_u
     local.set $6
     local.get $0
     i32.const 1
     i32.add
     local.set $0
     local.get $6
     i32.const 128
     i32.and
     if
      local.get $0
      local.get $4
      i32.eq
      br_if $while-break|0
      local.get $0
      i32.load8_u
      i32.const 63
      i32.and
      local.set $7
      local.get $0
      i32.const 1
      i32.add
      local.set $0
      local.get $6
      i32.const 224
      i32.and
      i32.const 192
      i32.eq
      if
       local.get $1
       local.get $6
       i32.const 31
       i32.and
       i32.const 6
       i32.shl
       local.get $7
       i32.or
       i32.store16
      else
       local.get $0
       local.get $4
       i32.eq
       br_if $while-break|0
       local.get $0
       i32.load8_u
       i32.const 63
       i32.and
       local.set $3
       local.get $0
       i32.const 1
       i32.add
       local.set $0
       local.get $6
       i32.const 240
       i32.and
       i32.const 224
       i32.eq
       if
        local.get $6
        i32.const 15
        i32.and
        i32.const 12
        i32.shl
        local.get $7
        i32.const 6
        i32.shl
        i32.or
        local.get $3
        i32.or
        local.set $3
       else
        local.get $0
        local.get $4
        i32.eq
        br_if $while-break|0
        local.get $0
        i32.load8_u
        i32.const 63
        i32.and
        local.get $6
        i32.const 7
        i32.and
        i32.const 18
        i32.shl
        local.get $7
        i32.const 12
        i32.shl
        i32.or
        local.get $3
        i32.const 6
        i32.shl
        i32.or
        i32.or
        local.set $3
        local.get $0
        i32.const 1
        i32.add
        local.set $0
       end
       local.get $3
       i32.const 65536
       i32.lt_u
       if
        local.get $1
        local.get $3
        i32.store16
       else
        local.get $1
        local.get $3
        i32.const 65536
        i32.sub
        local.tee $3
        i32.const 10
        i32.shr_u
        i32.const 55296
        i32.or
        local.get $3
        i32.const 1023
        i32.and
        i32.const 56320
        i32.or
        i32.const 16
        i32.shl
        i32.or
        i32.store
        local.get $1
        i32.const 2
        i32.add
        local.set $1
       end
      end
     else
      local.get $2
      local.get $6
      i32.eqz
      i32.and
      br_if $while-break|0
      local.get $1
      local.get $6
      i32.store16
     end
     local.get $1
     i32.const 2
     i32.add
     local.set $1
     br $while-continue|0
    end
   end
  end
  local.get $5
  local.get $1
  local.get $5
  i32.sub
  call $~lib/rt/stub/__renew
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.exit_arguments.encode (param $0 i32) (param $1 i32)
  local.get $0
  i32.load
  if
   local.get $1
   i32.const 8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load
   call $~lib/as-proto/assembly/Writer/Writer#int32@override
  end
  local.get $0
  i32.load offset=4
  local.tee $0
  if
   local.get $1
   i32.const 18
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#fork@override
   local.get $0
   i32.load
   i32.load offset=8
   if
    local.get $1
    i32.const 10
    call $~lib/as-proto/assembly/Writer/Writer#uint32@override
    local.get $1
    local.get $0
    i32.load
    call $~lib/as-proto/assembly/Writer/Writer#bytes@override
   end
   local.get $0
   i32.load offset=4
   local.tee $0
   if
    local.get $1
    i32.const 18
    call $~lib/as-proto/assembly/Writer/Writer#uint32@override
    local.get $1
    call $~lib/as-proto/assembly/Writer/Writer#fork@override
    local.get $0
    i32.load
    call $~lib/string/String#get:length
    if
     local.get $1
     i32.const 10
     call $~lib/as-proto/assembly/Writer/Writer#uint32@override
     local.get $1
     local.get $0
     i32.load
     call $~lib/as-proto/assembly/Writer/Writer#string@override
    end
    local.get $1
    call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
   end
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
  end
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.exit (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  i32.const 8
  i32.const 19
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  local.get $0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  if
   local.get $0
   if
    local.get $2
    i32.const 0
    call $~lib/typedarray/Uint8Array#constructor
    local.get $1
    if (result i32)
     local.get $1
     i32.load
     local.set $0
     local.get $1
     call $~lib/arraybuffer/ArrayBufferView#get:byteOffset
     local.set $3
     local.get $1
     i32.load offset=8
     local.get $1
     call $~lib/arraybuffer/ArrayBufferView#get:byteOffset
     i32.add
     local.set $1
     local.get $0
     call $~lib/arraybuffer/ArrayBuffer#get:byteLength
     local.set $4
     local.get $3
     i32.const 0
     i32.lt_s
     if (result i32)
      local.get $3
      local.get $4
      i32.add
      local.tee $3
      i32.const 0
      local.get $3
      i32.const 0
      i32.gt_s
      select
     else
      local.get $3
      local.get $4
      local.get $3
      local.get $4
      i32.lt_s
      select
     end
     local.set $3
     local.get $1
     i32.const 0
     i32.lt_s
     if (result i32)
      local.get $1
      local.get $4
      i32.add
      local.tee $1
      i32.const 0
      local.get $1
      i32.const 0
      i32.gt_s
      select
     else
      local.get $1
      local.get $4
      local.get $1
      local.get $4
      i32.lt_s
      select
     end
     local.get $3
     i32.sub
     local.tee $1
     i32.const 0
     local.get $1
     i32.const 0
     i32.gt_s
     select
     local.tee $1
     i32.const 1
     call $~lib/rt/stub/__new
     local.tee $4
     local.get $0
     local.get $3
     i32.add
     local.get $1
     call $~lib/memory/memory.copy
     local.get $4
     local.get $4
     call $~lib/arraybuffer/ArrayBuffer#get:byteLength
     i32.const 1
     call $~lib/string/String.UTF8.decodeUnsafe
    else
     i32.const 1152
    end
    call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data#constructor
    call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.result#constructor
    call $~lib/rt/common/OBJECT#set:gcInfo
   else
    local.get $2
    local.get $1
    i32.const 0
    call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.result#constructor
    call $~lib/rt/common/OBJECT#set:gcInfo
   end
  end
  local.get $2
  i32.const 1936
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 602
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  drop
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  if
   i32.const 0
   call $~lib/typedarray/Uint8Array#constructor
   local.set $2
   i32.const 2
   global.set $~argumentsLength
   local.get $0
   local.get $1
   i32.const 1904
   call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
   local.tee $0
   i32.load
   if (result i32)
    local.get $0
    i32.load
    call $~lib/@koinos/sdk-as/assembly/util/stringBytes/StringBytes.stringToBytes
   else
    local.get $2
   end
   call $~lib/@koinos/sdk-as/assembly/systemCalls/System.exit
  end
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_result.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $1
  i32.const 4
  i32.const 22
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $1
   i32.lt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $3
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     local.tee $3
     i32.const 0
     i32.lt_s
     if (result i32)
      local.get $0
      i32.load offset=4
     else
      local.get $3
      local.get $0
      i32.load
      i32.add
     end
     local.set $3
     i32.const 0
     global.set $~argumentsLength
     i32.const 0
     call $~lib/typedarray/Uint8Array#constructor
     local.set $4
     i32.const 8
     i32.const 23
     call $~lib/rt/stub/__new
     local.tee $5
     i32.const 0
     call $~lib/rt/common/BLOCK#set:mmInfo
     local.get $5
     i32.const 0
     call $~lib/rt/common/OBJECT#set:gcInfo
     local.get $5
     i32.const 0
     call $~lib/rt/common/BLOCK#set:mmInfo
     local.get $5
     local.get $4
     call $~lib/rt/common/OBJECT#set:gcInfo
     loop $while-continue|00
      local.get $3
      local.get $0
      i32.load
      i32.gt_u
      if
       block $case2|1
        block $case1|11
         local.get $0
         call $~lib/as-proto/assembly/Reader/Reader#uint32@override
         local.tee $4
         i32.const 3
         i32.shr_u
         local.tee $6
         i32.const 1
         i32.ne
         if
          local.get $6
          i32.const 2
          i32.eq
          br_if $case1|11
          br $case2|1
         end
         local.get $5
         local.get $0
         call $~lib/as-proto/assembly/Reader/Reader#uint32@override
         call $~lib/rt/common/BLOCK#set:mmInfo
         br $while-continue|00
        end
        local.get $5
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#bytes@override
        call $~lib/rt/common/OBJECT#set:gcInfo
        br $while-continue|00
       end
       local.get $0
       local.get $4
       i32.const 7
       i32.and
       call $~lib/as-proto/assembly/Reader/Reader#skipType@override
       br $while-continue|00
      end
     end
     local.get $2
     local.get $5
     call $~lib/rt/common/BLOCK#set:mmInfo
     br $while-continue|0
    end
    local.get $0
    local.get $3
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.getArguments (result i32)
  (local $0 i32)
  (local $1 i32)
  (local $2 i32)
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.cacheGetArguments
  if
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.cacheGetArguments
   local.tee $0
   i32.eqz
   if
    unreachable
   end
   local.get $0
   return
  end
  i32.const 0
  call $~lib/rt/stub/__alloc
  i32.const 1872
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 603
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/typedarray/Uint8Array#slice
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 1968
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
  local.set $1
  i32.const 8
  i32.const 14
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $0
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $0
  global.set $~lib/@koinos/sdk-as/assembly/systemCalls/System.cacheGetArguments
  local.get $1
  i32.load
  if
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.cacheGetArguments
   local.tee $2
   i32.eqz
   if
    unreachable
   end
   local.get $1
   i32.load
   local.tee $0
   i32.eqz
   if
    unreachable
   end
   local.get $2
   local.get $0
   i32.load
   call $~lib/rt/common/BLOCK#set:mmInfo
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.cacheGetArguments
   local.tee $0
   i32.eqz
   if
    unreachable
   end
   local.get $1
   i32.load
   local.tee $1
   i32.eqz
   if
    unreachable
   end
   local.get $0
   local.get $1
   i32.load offset=4
   call $~lib/rt/common/OBJECT#set:gcInfo
  end
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.cacheGetArguments
  local.tee $0
  i32.eqz
  if
   unreachable
  end
  local.get $0
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_contract_id_result.decode (param $0 i32) (param $1 i32) (result i32)
  local.get $0
  local.get $1
  i32.const 32
  call $byn$mgfn-shared$~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_contract_id_result.decode
 )
 (func $assembly/proto/race/race.config#set:enabled (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store8 offset=4
 )
 (func $assembly/proto/race/race.config#constructor (result i32)
  (local $0 i32)
  i32.const 12
  i32.const 26
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.const 0
  call $assembly/proto/race/race.config#set:enabled
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $0
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.const 0
  call $assembly/proto/race/race.config#set:enabled
  local.get $0
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $0
 )
 (func $assembly/proto/race/race.config.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $3
  call $assembly/proto/race/race.config#constructor
  local.set $2
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $3
   i32.lt_u
   if
    block $case3|1
     block $case2|1
      block $case1|1
       block $case0|1
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#uint32@override
        local.tee $1
        i32.const 3
        i32.shr_u
        i32.const 1
        i32.sub
        br_table $case0|1 $case1|1 $case2|1 $case3|1
       end
       local.get $2
       local.get $0
       call $~lib/as-proto/assembly/Reader/Reader#bytes@override
       call $~lib/rt/common/BLOCK#set:mmInfo
       br $while-continue|0
      end
      local.get $2
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#bool@override
      call $assembly/proto/race/race.config#set:enabled
      br $while-continue|0
     end
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     call $~lib/rt/common/OBJECT#set:gcInfo2
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $assembly/proto/race/race.config.encode (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  i32.load
  local.tee $2
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $2
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i32.load8_u offset=4
  if
   local.get $1
   i32.const 16
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load8_u offset=4
   call $~lib/as-proto/assembly/Writer/Writer#bool@override
  end
  local.get $0
  i32.load offset=8
  if
   local.get $1
   i32.const 24
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
  end
 )
 (func $assembly/Race/Race#constructor~anonymous|0 (result i32)
  call $assembly/proto/race/race.config#constructor
 )
 (func $assembly/proto/race/race.pick_object#set:at (param $0 i32) (param $1 i64)
  local.get $0
  local.get $1
  i64.store offset=8
 )
 (func $assembly/proto/race/race.pick_object#constructor (param $0 i32) (param $1 i64) (param $2 i32) (result i32)
  (local $3 i32)
  i32.const 20
  i32.const 28
  call $~lib/rt/stub/__new
  local.tee $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  local.get $3
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $3
  local.get $0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  local.get $1
  call $assembly/proto/race/race.pick_object#set:at
  local.get $3
  local.get $2
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $3
 )
 (func $assembly/proto/race/race.pick_object.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $3
  i32.const 0
  i64.const 0
  i32.const 0
  call $assembly/proto/race/race.pick_object#constructor
  local.set $2
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $3
   i32.lt_u
   if
    block $case3|1
     block $case2|1
      block $case1|1
       block $case0|1
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#uint32@override
        local.tee $1
        i32.const 3
        i32.shr_u
        i32.const 1
        i32.sub
        br_table $case0|1 $case1|1 $case2|1 $case3|1
       end
       local.get $2
       local.get $0
       call $~lib/as-proto/assembly/Reader/Reader#bytes@override
       call $~lib/rt/common/BLOCK#set:mmInfo
       br $while-continue|0
      end
      local.get $2
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#uint64@override
      call $assembly/proto/race/race.pick_object#set:at
      br $while-continue|0
     end
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     call $~lib/rt/common/OBJECT#set:rtSize
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $assembly/proto/race/race.pick_object.encode (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  i32.load
  local.tee $2
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $2
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i64.load offset=8
  i64.const 0
  i64.ne
  if
   local.get $1
   i32.const 16
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i64.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#uint64@override
  end
  local.get $0
  i32.load offset=16
  if
   local.get $1
   i32.const 24
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=16
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
  end
 )
 (func $assembly/Race/Race#constructor~anonymous|1 (result i32)
  i32.const 0
  i64.const 0
  i32.const 0
  call $assembly/proto/race/race.pick_object#constructor
 )
 (func $assembly/proto/race/race.day_count#set:day (param $0 i32) (param $1 i64)
  local.get $0
  local.get $1
  i64.store
 )
 (func $assembly/proto/race/race.day_count#constructor (param $0 i64) (param $1 i32) (result i32)
  (local $2 i32)
  i32.const 12
  call $~lib/rt/stub/__alloc
  local.tee $2
  i64.const 0
  call $assembly/proto/race/race.day_count#set:day
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  local.get $0
  call $assembly/proto/race/race.day_count#set:day
  local.get $2
  local.get $1
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
 )
 (func $assembly/proto/race/race.day_count.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $4
  i64.const 0
  i32.const 0
  call $assembly/proto/race/race.day_count#constructor
  local.set $3
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $4
   i32.lt_u
   if
    block $case2|1
     block $case1|1
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#uint32@override
      local.tee $1
      i32.const 3
      i32.shr_u
      local.tee $2
      i32.const 1
      i32.ne
      if
       local.get $2
       i32.const 2
       i32.eq
       br_if $case1|1
       br $case2|1
      end
      local.get $3
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#uint64@override
      call $assembly/proto/race/race.day_count#set:day
      br $while-continue|0
     end
     local.get $3
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     call $~lib/rt/common/OBJECT#set:gcInfo2
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $3
 )
 (func $assembly/proto/race/race.day_count.encode (param $0 i32) (param $1 i32)
  local.get $0
  i64.load
  i64.const 0
  i64.ne
  if
   local.get $1
   i32.const 8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i64.load
   call $~lib/as-proto/assembly/Writer/Writer#uint64@override
  end
  local.get $0
  i32.load offset=8
  if
   local.get $1
   i32.const 16
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
  end
 )
 (func $assembly/Race/Race#constructor~anonymous|2 (result i32)
  i64.const 0
  i32.const 0
  call $assembly/proto/race/race.day_count#constructor
 )
 (func $assembly/Race/Race#constructor (result i32)
  (local $0 i32)
  (local $1 i32)
  (local $2 i32)
  i32.const 16
  i32.const 25
  call $~lib/rt/stub/__new
  call $~lib/object/Object#constructor
  local.set $0
  i32.const 0
  call $~lib/rt/stub/__alloc
  i32.const 2000
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $1
  i32.const 604
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $1
  i32.load offset=4
  local.get $1
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/typedarray/Uint8Array#slice
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
  local.get $0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 2032
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
  i32.load
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.load
  local.set $1
  i32.const 16
  i32.const 27
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $2
  i32.const 0
  local.get $1
  i32.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#constructor
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 2128
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 2064
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 2096
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
  local.get $2
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $0
  i32.load
  local.set $1
  i32.const 16
  i32.const 29
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $2
  i32.const 0
  local.get $1
  i32.const 1
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#constructor
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 2224
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 2160
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 2192
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
  local.get $2
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $0
  i32.load
  local.set $1
  i32.const 16
  i32.const 30
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $2
  i32.const 0
  local.get $1
  i32.const 2
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#constructor
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 2320
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 2256
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 2288
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
  local.get $2
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
 )
 (func $assembly/proto/race/race.pick_arguments.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $3
  i32.const 20
  i32.const 43
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtSize
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $3
   i32.lt_u
   if
    block $case3|1
     block $case2|1
      block $case1|1
       block $case0|1
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#uint32@override
        local.tee $1
        i32.const 3
        i32.shr_u
        i32.const 1
        i32.sub
        br_table $case0|1 $case1|1 $case2|1 $case3|1
       end
       local.get $2
       local.get $0
       call $~lib/as-proto/assembly/Reader/Reader#bytes@override
       call $~lib/rt/common/BLOCK#set:mmInfo
       br $while-continue|0
      end
      local.get $2
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#uint64@override
      call $assembly/proto/race/race.pick_object#set:at
      br $while-continue|0
     end
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#bytes@override
     call $~lib/rt/common/OBJECT#set:rtSize
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space.encode (param $0 i32) (param $1 i32)
  local.get $0
  i32.load8_u
  if
   local.get $1
   i32.const 8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load8_u
   call $~lib/as-proto/assembly/Writer/Writer#bool@override
  end
  local.get $0
  i32.load offset=4
  i32.load offset=8
  if
   local.get $1
   i32.const 18
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=4
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i32.load offset=8
  if
   local.get $1
   i32.const 24
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
  end
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_arguments.encode (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  i32.load
  local.tee $2
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#fork@override
   local.get $2
   local.get $1
   call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space.encode
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
  end
  local.get $0
  i32.load offset=4
  i32.load offset=8
  if
   local.get $1
   i32.const 18
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=4
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.database_object.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $1
   local.get $0
   i32.load
   i32.add
  end
  local.set $3
  i32.const 0
  global.set $~argumentsLength
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  local.set $1
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  local.set $4
  i32.const 12
  i32.const 48
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
  local.get $2
  local.get $1
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $2
  local.get $4
  call $~lib/rt/common/OBJECT#set:gcInfo2
  loop $while-continue|0
   local.get $3
   local.get $0
   i32.load
   i32.gt_u
   if
    block $case3|1
     block $case2|1
      block $case1|1
       block $case0|1
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#uint32@override
        local.tee $1
        i32.const 3
        i32.shr_u
        i32.const 1
        i32.sub
        br_table $case0|1 $case1|1 $case2|1 $case3|1
       end
       local.get $2
       local.get $0
       call $~lib/as-proto/assembly/Reader/Reader#bool@override
       call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
       br $while-continue|0
      end
      local.get $2
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#bytes@override
      call $~lib/rt/common/OBJECT#set:gcInfo
      br $while-continue|0
     end
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#bytes@override
     call $~lib/rt/common/OBJECT#set:gcInfo2
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_result.decode (param $0 i32) (param $1 i32) (result i32)
  local.get $0
  local.get $1
  i32.const 47
  call $byn$mgfn-shared$~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_result.decode
 )
 (func $"~lib/@koinos/sdk-as/assembly/systemCalls/System.getObject<~lib/typedarray/Uint8Array,assembly/proto/race/race.config>" (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  block $__inlined_func$~lib/@koinos/sdk-as/assembly/systemCalls/System.getBytes<~lib/typedarray/Uint8Array>$9 (result i32)
   i32.const 0
   call $~lib/typedarray/Uint8Array#constructor
   drop
   i32.const 8
   i32.const 45
   call $~lib/rt/stub/__new
   local.tee $3
   i32.const 0
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $3
   i32.const 0
   call $~lib/rt/common/OBJECT#set:gcInfo
   local.get $3
   local.get $0
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $3
   local.get $1
   call $~lib/rt/common/OBJECT#set:gcInfo
   local.get $3
   i32.const 2384
   call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
   local.set $0
   i32.const 303
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
   i32.load offset=4
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
   local.get $0
   i32.load offset=4
   local.get $0
   i32.load offset=8
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
   i32.load offset=4
   call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
   i32.const 0
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
   call $~lib/typedarray/Uint32Array#__get
   call $~lib/typedarray/Uint8Array#slice
   call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
   i32.const 0
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
   call $~lib/typedarray/Uint32Array#__get
   i32.eqz
   br_if $__inlined_func$~lib/@koinos/sdk-as/assembly/systemCalls/System.getBytes<~lib/typedarray/Uint8Array>$9
   drop
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
   i32.const 2416
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
   call $~lib/typedarray/Uint32Array#__get
   call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
   i32.load
   local.tee $0
   i32.eqz
   if
    unreachable
   end
   local.get $0
   i32.load offset=4
  end
  local.tee $0
  i32.eqz
  if
   i32.const 0
   return
  end
  i32.const 2
  global.set $~argumentsLength
  local.get $0
  local.get $2
  call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
 )
 (func $~lib/@koinos/sdk-as/assembly/util/storage/Storage.Obj<assembly/proto/race/race.config>#get (param $0 i32) (result i32)
  (local $1 i32)
  local.get $0
  i32.load
  global.get $~lib/@koinos/sdk-as/assembly/util/storage/DEFAULT_KEY
  local.get $0
  i32.load offset=8
  call $"~lib/@koinos/sdk-as/assembly/systemCalls/System.getObject<~lib/typedarray/Uint8Array,assembly/proto/race/race.config>"
  local.tee $1
  if (result i32)
   i32.const 0
  else
   local.get $0
   i32.load offset=4
  end
  if
   i32.const 0
   global.set $~argumentsLength
   local.get $0
   i32.load offset=4
   i32.load
   call_indirect (type $4)
   return
  end
  local.get $1
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool> (param $0 i32) (param $1 i32)
  local.get $0
  i32.eqz
  if
   i32.const 1
   local.get $1
   call $~lib/@koinos/sdk-as/assembly/util/stringBytes/StringBytes.stringToBytes
   call $~lib/@koinos/sdk-as/assembly/systemCalls/System.exit
  end
 )
 (func $~lib/typedarray/Uint8Array#__get (param $0 i32) (param $1 i32) (result i32)
  local.get $1
  local.get $0
  i32.load offset=8
  i32.ge_u
  if
   unreachable
  end
  local.get $0
  i32.load offset=4
  local.get $1
  i32.add
  i32.load8_u
 )
 (func $~lib/typedarray/Uint8Array#subarray (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  i32.load offset=8
  local.set $3
  i32.const 12
  i32.const 9
  call $~lib/rt/stub/__new
  local.tee $4
  local.get $0
  i32.load
  i32.store
  local.get $4
  local.get $0
  i32.load offset=4
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $1
   local.get $3
   i32.add
   local.tee $0
   i32.const 0
   local.get $0
   i32.const 0
   i32.gt_s
   select
  else
   local.get $1
   local.get $3
   local.get $1
   local.get $3
   i32.lt_s
   select
  end
  local.tee $0
  i32.add
  i32.store offset=4
  local.get $4
  local.get $2
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $2
   local.get $3
   i32.add
   local.tee $1
   i32.const 0
   local.get $1
   i32.const 0
   i32.gt_s
   select
  else
   local.get $2
   local.get $3
   local.get $2
   local.get $3
   i32.lt_s
   select
  end
  local.tee $1
  local.get $0
  local.get $0
  local.get $1
  i32.lt_s
  select
  local.get $0
  i32.sub
  i32.store offset=8
  local.get $4
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments#set:size (param $0 i32) (param $1 i64)
  local.get $0
  local.get $1
  i64.store offset=16
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments.encode (param $0 i32) (param $1 i32)
  local.get $0
  i64.load
  i64.const 0
  i64.ne
  if
   local.get $1
   i32.const 8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i64.load
   call $~lib/as-proto/assembly/Writer/Writer#uint64@override
  end
  local.get $0
  i32.load offset=8
  i32.load offset=8
  if
   local.get $1
   i32.const 18
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i64.load offset=16
  i64.const 0
  i64.ne
  if
   local.get $1
   i32.const 24
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i64.load offset=16
   call $~lib/as-proto/assembly/Writer/Writer#uint64@override
  end
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_result.decode (param $0 i32) (param $1 i32) (result i32)
  local.get $0
  local.get $1
  i32.const 52
  call $byn$mgfn-shared$~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_contract_id_result.decode
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.hash (param $0 i32) (result i32)
  (local $1 i32)
  i32.const 24
  i32.const 50
  call $~lib/rt/stub/__new
  local.tee $1
  i64.const 0
  call $assembly/proto/race/race.day_count#set:day
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  i64.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments#set:size
  local.get $1
  i64.const 18
  call $assembly/proto/race/race.day_count#set:day
  local.get $1
  local.get $0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  i64.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments#set:size
  local.get $1
  i32.const 2448
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 501
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/typedarray/Uint8Array#slice
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 2480
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
  i32.load
 )
 (func $assembly/Race/isAddress (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  local.get $0
  i32.eqz
  if
   i32.const 0
   return
  end
  local.get $0
  i32.load offset=8
  i32.const 25
  i32.ne
  if (result i32)
   i32.const 1
  else
   local.get $0
   i32.const 0
   call $~lib/typedarray/Uint8Array#__get
  end
  if
   i32.const 0
   return
  end
  local.get $0
  i32.const 0
  i32.const 21
  call $~lib/typedarray/Uint8Array#subarray
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.hash
  local.tee $2
  i32.eqz
  if
   i32.const 0
   return
  end
  i32.const 1
  global.set $~argumentsLength
  local.get $2
  i32.const 2
  i32.const 2147483647
  call $~lib/typedarray/Uint8Array#subarray
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.hash
  local.tee $2
  i32.eqz
  if
   i32.const 0
   return
  end
  loop $for-loop|0
   local.get $1
   i32.const 4
   i32.lt_s
   if
    local.get $2
    local.get $1
    i32.const 2
    i32.add
    call $~lib/typedarray/Uint8Array#__get
    local.get $0
    local.get $1
    i32.const 21
    i32.add
    call $~lib/typedarray/Uint8Array#__get
    i32.ne
    if
     i32.const 0
     return
    end
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|0
   end
  end
  i32.const 1
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.check_authority_arguments.encode (param $0 i32) (param $1 i32)
  local.get $0
  i32.load
  if
   local.get $1
   i32.const 8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load
   call $~lib/as-proto/assembly/Writer/Writer#int32@override
  end
  local.get $0
  i32.load offset=4
  i32.load offset=8
  if
   local.get $1
   i32.const 18
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=4
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i32.load offset=8
  i32.load offset=8
  if
   local.get $1
   i32.const 26
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.check_authority_result.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $3
  i32.const 1
  call $~lib/rt/stub/__alloc
  local.tee $2
  i32.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
  local.get $2
  i32.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $3
   i32.lt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $1
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#bool@override
     call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#set:system
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkAuthority (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  local.set $2
  i32.const 12
  i32.const 54
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  local.get $0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $1
  local.get $2
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $1
  i32.const 2640
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 606
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/typedarray/Uint8Array#slice
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 2672
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
  i32.load8_u
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/common/common.block_topology.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $1
   local.get $0
   i32.load
   i32.add
  end
  local.set $3
  i32.const 0
  global.set $~argumentsLength
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  local.set $1
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  local.set $4
  i32.const 20
  i32.const 58
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $2
  local.get $1
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  local.get $2
  local.get $4
  call $~lib/rt/common/OBJECT#set:rtSize
  loop $while-continue|0
   local.get $3
   local.get $0
   i32.load
   i32.gt_u
   if
    block $case3|1
     block $case2|1
      block $case1|1
       block $case0|1
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#uint32@override
        local.tee $1
        i32.const 3
        i32.shr_u
        i32.const 1
        i32.sub
        br_table $case0|1 $case1|1 $case2|1 $case3|1
       end
       local.get $2
       local.get $0
       call $~lib/as-proto/assembly/Reader/Reader#bytes@override
       call $~lib/rt/common/BLOCK#set:mmInfo
       br $while-continue|0
      end
      local.get $2
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#uint64@override
      call $assembly/proto/race/race.pick_object#set:at
      br $while-continue|0
     end
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#bytes@override
     call $~lib/rt/common/OBJECT#set:rtSize
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_head_info_result.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $1
  i32.const 4
  i32.const 60
  call $~lib/rt/stub/__new
  local.tee $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $1
   i32.lt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $2
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     local.tee $2
     i32.const 0
     i32.lt_s
     if (result i32)
      local.get $0
      i32.load offset=4
     else
      local.get $0
      i32.load
      local.get $2
      i32.add
     end
     local.set $4
     i32.const 24
     i32.const 57
     call $~lib/rt/stub/__new
     local.tee $5
     i32.const 0
     call $~lib/rt/common/BLOCK#set:mmInfo
     local.get $5
     i64.const 0
     call $assembly/proto/race/race.pick_object#set:at
     local.get $5
     i64.const 0
     call $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments#set:size
     local.get $5
     i32.const 0
     call $~lib/rt/common/BLOCK#set:mmInfo
     local.get $5
     i64.const 0
     call $assembly/proto/race/race.pick_object#set:at
     local.get $5
     i64.const 0
     call $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments#set:size
     loop $while-continue|00
      local.get $0
      i32.load
      local.get $4
      i32.lt_u
      if
       block $case3|1
        block $case2|1
         block $case1|11
          block $case0|1
           local.get $0
           call $~lib/as-proto/assembly/Reader/Reader#uint32@override
           local.tee $2
           i32.const 3
           i32.shr_u
           i32.const 1
           i32.sub
           br_table $case0|1 $case1|11 $case2|1 $case3|1
          end
          local.get $5
          local.get $0
          local.get $0
          call $~lib/as-proto/assembly/Reader/Reader#uint32@override
          call $~lib/@koinos/proto-as/assembly/koinos/common/common.block_topology.decode
          call $~lib/rt/common/BLOCK#set:mmInfo
          br $while-continue|00
         end
         local.get $5
         local.get $0
         call $~lib/as-proto/assembly/Reader/Reader#uint64@override
         call $assembly/proto/race/race.pick_object#set:at
         br $while-continue|00
        end
        local.get $5
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#uint64@override
        call $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.hash_arguments#set:size
        br $while-continue|00
       end
       local.get $0
       local.get $2
       i32.const 7
       i32.and
       call $~lib/as-proto/assembly/Reader/Reader#skipType@override
       br $while-continue|00
      end
     end
     local.get $3
     local.get $5
     call $~lib/rt/common/BLOCK#set:mmInfo
     br $while-continue|0
    end
    local.get $0
    local.get $2
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $3
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.getHeadInfo (result i32)
  (local $0 i32)
  i32.const 0
  call $~lib/rt/stub/__alloc
  i32.const 2704
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 1
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/typedarray/Uint8Array#slice
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 2736
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
  i32.load
  local.tee $0
  i32.eqz
  if
   unreachable
  end
  local.get $0
 )
 (func $assembly/Race/raceBytes (param $0 i64) (result i32)
  (local $1 i32)
  (local $2 i32)
  i32.const 8
  call $~lib/typedarray/Uint8Array#constructor
  local.set $2
  i32.const 7
  local.set $1
  loop $for-loop|0
   local.get $1
   i32.const 0
   i32.ge_s
   if
    local.get $1
    local.get $2
    i32.load offset=8
    i32.ge_u
    if
     unreachable
    end
    local.get $2
    i32.load offset=4
    local.get $1
    i32.add
    local.get $0
    i64.const 255
    i64.and
    i64.store8
    local.get $0
    i64.const 8
    i64.shr_u
    local.set $0
    local.get $1
    i32.const 1
    i32.sub
    local.set $1
    br $for-loop|0
   end
  end
  local.get $2
 )
 (func $~lib/typedarray/Uint8Array#set<~lib/typedarray/Uint8Array> (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  local.get $1
  i32.load offset=8
  local.set $3
  local.get $2
  i32.const 0
  i32.lt_s
  if (result i32)
   i32.const 1
  else
   local.get $0
   i32.load offset=8
   local.get $2
   local.get $3
   i32.add
   i32.lt_s
  end
  if
   unreachable
  end
  local.get $0
  i32.load offset=4
  local.get $2
  i32.add
  local.get $1
  i32.load offset=4
  local.get $3
  call $~lib/memory/memory.copy
 )
 (func $assembly/Race/concat (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  local.get $0
  i32.load offset=8
  local.get $1
  i32.load offset=8
  i32.add
  call $~lib/typedarray/Uint8Array#constructor
  local.tee $2
  local.get $0
  i32.const 0
  call $~lib/typedarray/Uint8Array#set<~lib/typedarray/Uint8Array>
  local.get $2
  local.get $1
  local.get $0
  i32.load offset=8
  call $~lib/typedarray/Uint8Array#set<~lib/typedarray/Uint8Array>
  local.get $2
 )
 (func $assembly/Race/pickKey (param $0 i64) (param $1 i32) (result i32)
  local.get $0
  call $assembly/Race/raceBytes
  local.get $1
  call $assembly/Race/concat
 )
 (func $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.pick_object>#get" (param $0 i32) (param $1 i32) (result i32)
  local.get $0
  i32.load
  local.get $1
  local.get $0
  i32.load offset=8
  call $"~lib/@koinos/sdk-as/assembly/systemCalls/System.getObject<~lib/typedarray/Uint8Array,assembly/proto/race/race.config>"
  local.tee $1
  if (result i32)
   i32.const 0
  else
   local.get $0
   i32.load offset=4
  end
  if
   i32.const 0
   global.set $~argumentsLength
   local.get $0
   i32.load offset=4
   i32.load
   call_indirect (type $4)
   return
  end
  local.get $1
 )
 (func $~lib/@koinos/sdk-as/assembly/util/arrays/Arrays.equal (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  local.get $1
  i32.or
  i32.eqz
  if
   i32.const 1
   return
  end
  local.get $0
  i32.eqz
  local.get $1
  i32.const 0
  i32.ne
  i32.and
  if
   i32.const 0
   return
  end
  local.get $1
  i32.const 1
  local.get $0
  select
  i32.eqz
  if
   i32.const 0
   return
  end
  local.get $0
  i32.eqz
  if
   unreachable
  end
  local.get $0
  i32.load offset=8
  local.set $2
  local.get $1
  i32.eqz
  if
   unreachable
  end
  local.get $2
  local.get $1
  i32.load offset=8
  i32.ne
  if
   i32.const 0
   return
  end
  local.get $0
  if (result i32)
   local.get $0
  else
   unreachable
  end
  local.set $2
  loop $for-loop|0
   local.get $3
   local.get $2
   i32.load offset=8
   i32.lt_s
   if
    local.get $0
    i32.eqz
    if
     unreachable
    end
    local.get $0
    local.get $3
    call $~lib/typedarray/Uint8Array#__get
    local.set $4
    local.get $1
    i32.eqz
    if
     unreachable
    end
    local.get $1
    local.get $3
    call $~lib/typedarray/Uint8Array#__get
    local.get $4
    i32.ne
    if
     i32.const 0
     return
    end
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|0
   end
  end
  i32.const 1
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.put_object_arguments.encode (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  i32.load
  local.tee $2
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#fork@override
   local.get $2
   local.get $1
   call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space.encode
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
  end
  local.get $0
  i32.load offset=4
  i32.load offset=8
  if
   local.get $1
   i32.const 18
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=4
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i32.load offset=8
  i32.load offset=8
  if
   local.get $1
   i32.const 26
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
 )
 (func $"~lib/@koinos/sdk-as/assembly/systemCalls/System.putObject<~lib/typedarray/Uint8Array,assembly/proto/race/race.day_count>" (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32)
  local.get $2
  local.get $3
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $2
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  drop
  i32.const 12
  i32.const 62
  call $~lib/rt/stub/__new
  local.tee $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $3
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $3
  local.get $0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  local.get $1
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $3
  local.get $2
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $3
  i32.const 2768
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 301
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/typedarray/Uint8Array#slice
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
 )
 (func $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.day_count>#put" (param $0 i32) (param $1 i32) (param $2 i32)
  local.get $0
  i32.load
  local.get $1
  local.get $2
  local.get $0
  i32.load offset=12
  call $"~lib/@koinos/sdk-as/assembly/systemCalls/System.putObject<~lib/typedarray/Uint8Array,assembly/proto/race/race.day_count>"
 )
 (func $assembly/proto/race/race.pick_event#set:at (param $0 i32) (param $1 i64)
  local.get $0
  local.get $1
  i64.store offset=24
 )
 (func $assembly/proto/race/race.pick_event#set:change (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store8 offset=32
 )
 (func $assembly/proto/race/race.pick_event.encode (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  i32.load
  local.tee $2
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $2
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i64.load offset=8
  i64.const 0
  i64.ne
  if
   local.get $1
   i32.const 16
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i64.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#uint64@override
  end
  local.get $0
  i32.load offset=16
  local.tee $2
  if
   local.get $1
   i32.const 26
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $2
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i64.load offset=24
  i64.const 0
  i64.ne
  if
   local.get $1
   i32.const 32
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i64.load offset=24
   call $~lib/as-proto/assembly/Writer/Writer#uint64@override
  end
  local.get $0
  i32.load8_u offset=32
  if
   local.get $1
   i32.const 40
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load8_u offset=32
   call $~lib/as-proto/assembly/Writer/Writer#bool@override
  end
 )
 (func $~lib/array/Array<~lib/typedarray/Uint8Array>#__set (param $0 i32) (param $1 i32)
  local.get $0
  i32.load offset=12
  i32.eqz
  if
   local.get $0
   i32.const 1
   i32.const 1
   call $~lib/array/ensureCapacity
   local.get $0
   i32.const 1
   call $~lib/rt/common/OBJECT#set:rtId
  end
  local.get $0
  i32.load offset=4
  local.get $1
  i32.store
 )
 (func $~lib/array/Array<~lib/typedarray/Uint8Array>#__get (param $0 i32) (param $1 i32) (result i32)
  local.get $1
  local.get $0
  i32.load offset=12
  i32.ge_u
  if
   unreachable
  end
  local.get $0
  i32.load offset=4
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  i32.load
  local.tee $0
  i32.eqz
  if
   unreachable
  end
  local.get $0
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.event_arguments.encode (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  i32.load
  call $~lib/string/String#get:length
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load
   call $~lib/as-proto/assembly/Writer/Writer#string@override
  end
  local.get $0
  i32.load offset=4
  i32.load offset=8
  if
   local.get $1
   i32.const 18
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=4
   call $~lib/as-proto/assembly/Writer/Writer#bytes@override
  end
  local.get $0
  i32.load offset=8
  local.tee $0
  i32.load offset=12
  if
   loop $for-loop|0
    local.get $2
    local.get $0
    i32.load offset=12
    i32.lt_s
    if
     local.get $1
     i32.const 26
     call $~lib/as-proto/assembly/Writer/Writer#uint32@override
     local.get $1
     local.get $0
     local.get $2
     call $~lib/array/Array<~lib/typedarray/Uint8Array>#__get
     call $~lib/as-proto/assembly/Writer/Writer#bytes@override
     local.get $2
     i32.const 1
     i32.add
     local.set $2
     br $for-loop|0
    end
   end
  end
 )
 (func $~lib/@koinos/sdk-as/assembly/systemCalls/System.event (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  i32.const 12
  i32.const 67
  call $~lib/rt/stub/__new
  local.tee $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $3
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $3
  local.get $0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  local.get $1
  call $~lib/rt/common/OBJECT#set:gcInfo
  local.get $3
  local.get $2
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $3
  i32.const 2896
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 402
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.load offset=4
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load offset=8
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 0
  global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $~lib/typedarray/Uint32Array#__get
  call $~lib/typedarray/Uint8Array#slice
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
 )
 (func $assembly/Race/Race#pick (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i64)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i64)
  (local $9 i32)
  local.get $0
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/util/storage/Storage.Obj<assembly/proto/race/race.config>#get
  local.tee $3
  if (result i32)
   local.get $3
  else
   unreachable
  end
  i32.load8_u offset=4
  i32.const 1184
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i32.load
  call $assembly/Race/isAddress
  i32.const 2512
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i32.load offset=16
  call $assembly/Race/isAddress
  i32.const 2576
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i32.load
  local.tee $5
  i32.eqz
  if
   unreachable
  end
  local.get $5
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkAuthority
  i32.const 1664
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.getHeadInfo
  i64.load offset=8
  local.tee $4
  i64.const 21600000
  i64.div_u
  local.tee $8
  local.get $1
  i64.load offset=8
  i64.lt_u
  i32.const 1248
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i64.load offset=8
  local.get $8
  i64.const 4
  i64.add
  i64.le_u
  i32.const 1360
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i64.load offset=8
  local.get $5
  call $assembly/Race/pickKey
  local.set $6
  local.get $0
  i32.load offset=8
  local.get $6
  call $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.pick_object>#get"
  local.tee $7
  i32.const 0
  i32.ne
  local.tee $2
  if
   local.get $7
   i32.load
   i32.const 0
   i32.ne
   local.set $2
  end
  local.get $2
  if
   local.get $7
   i32.load
   local.tee $2
   i32.eqz
   if
    unreachable
   end
   local.get $2
   i32.load offset=8
   i32.const 0
   i32.gt_s
   local.set $2
  end
  local.get $2
  if (result i32)
   local.get $7
   i32.eqz
   if
    unreachable
   end
   local.get $7
   i32.load
   local.get $1
   i32.load offset=16
   call $~lib/@koinos/sdk-as/assembly/util/arrays/Arrays.equal
  else
   i32.const 0
  end
  i32.eqz
  i32.const 1568
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $0
  i32.load offset=12
  local.get $5
  call $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.pick_object>#get"
  local.tee $9
  i32.eqz
  if
   unreachable
  end
  local.get $4
  i64.const 86400000
  i64.div_u
  local.tee $8
  local.get $9
  i64.load
  i64.eq
  if (result i32)
   local.get $9
   i32.load offset=8
  else
   i32.const 0
  end
  local.tee $9
  local.get $3
  i32.load offset=8
  i32.lt_u
  i32.const 1472
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $0
  i32.load offset=12
  local.get $5
  local.get $8
  local.get $9
  i32.const 1
  i32.add
  call $assembly/proto/race/race.day_count#constructor
  call $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.day_count>#put"
  local.get $0
  i32.load offset=8
  local.get $6
  local.get $1
  i32.load offset=16
  local.get $4
  local.get $2
  if (result i32)
   local.get $7
   i32.eqz
   if
    unreachable
   end
   local.get $7
   i32.load offset=16
   i32.const 1
   i32.add
  else
   i32.const 0
  end
  call $assembly/proto/race/race.pick_object#constructor
  call $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.day_count>#put"
  local.get $1
  i64.load offset=8
  local.set $8
  local.get $1
  i32.load offset=16
  local.set $0
  i32.const 33
  i32.const 64
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  local.get $1
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $1
  i64.const 0
  call $assembly/proto/race/race.pick_event#set:at
  local.get $1
  i32.const 0
  call $assembly/proto/race/race.pick_event#set:change
  local.get $1
  local.get $5
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  local.get $8
  call $assembly/proto/race/race.pick_object#set:at
  local.get $1
  local.get $0
  call $~lib/rt/common/OBJECT#set:rtSize
  local.get $1
  local.get $4
  call $assembly/proto/race/race.pick_event#set:at
  local.get $1
  local.get $2
  call $assembly/proto/race/race.pick_event#set:change
  local.get $1
  i32.const 2864
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $0
  i32.const 1
  i32.const 65
  i32.const 0
  call $~lib/rt/__newArray
  local.tee $1
  i32.load offset=4
  drop
  local.get $1
  local.get $5
  call $~lib/array/Array<~lib/typedarray/Uint8Array>#__set
  i32.const 2800
  local.get $0
  local.get $1
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.event
  i32.const 0
  call $~lib/rt/stub/__alloc
 )
 (func $assembly/proto/race/race.get_pick_arguments.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $4
  i32.const 16
  i32.const 70
  call $~lib/rt/stub/__new
  local.tee $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  local.get $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  i64.const 0
  call $assembly/proto/race/race.pick_object#set:at
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $4
   i32.lt_u
   if
    block $case2|1
     block $case1|1
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#uint32@override
      local.tee $1
      i32.const 3
      i32.shr_u
      local.tee $2
      i32.const 1
      i32.ne
      if
       local.get $2
       i32.const 2
       i32.eq
       br_if $case1|1
       br $case2|1
      end
      local.get $3
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#bytes@override
      call $~lib/rt/common/BLOCK#set:mmInfo
      br $while-continue|0
     end
     local.get $3
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint64@override
     call $assembly/proto/race/race.pick_object#set:at
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $3
 )
 (func $assembly/proto/race/race.get_pick_result.encode (param $0 i32) (param $1 i32)
  local.get $0
  i32.load
  local.tee $0
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#fork@override
   local.get $0
   local.get $1
   call $assembly/proto/race/race.pick_object.encode
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
  end
 )
 (func $assembly/proto/race/race.list_picks_arguments.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $3
  i32.const 16
  i32.const 74
  call $~lib/rt/stub/__new
  local.tee $2
  i64.const 0
  call $assembly/proto/race/race.day_count#set:day
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $2
  i64.const 0
  call $assembly/proto/race/race.day_count#set:day
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:gcInfo2
  local.get $2
  i32.const 0
  call $~lib/rt/common/OBJECT#set:rtId
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $3
   i32.lt_u
   if
    block $case3|1
     block $case2|1
      block $case1|1
       block $case0|1
        local.get $0
        call $~lib/as-proto/assembly/Reader/Reader#uint32@override
        local.tee $1
        i32.const 3
        i32.shr_u
        i32.const 1
        i32.sub
        br_table $case0|1 $case1|1 $case2|1 $case3|1
       end
       local.get $2
       local.get $0
       call $~lib/as-proto/assembly/Reader/Reader#uint64@override
       call $assembly/proto/race/race.day_count#set:day
       br $while-continue|0
      end
      local.get $2
      local.get $0
      call $~lib/as-proto/assembly/Reader/Reader#bytes@override
      call $~lib/rt/common/OBJECT#set:gcInfo2
      br $while-continue|0
     end
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     call $~lib/rt/common/OBJECT#set:rtId
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_next_object_result.decode (param $0 i32) (param $1 i32) (result i32)
  local.get $0
  local.get $1
  i32.const 82
  call $byn$mgfn-shared$~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_result.decode
 )
 (func $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.pick_object>#getNext" (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $0
  i32.load offset=8
  local.set $2
  block $__inlined_func$~lib/@koinos/sdk-as/assembly/systemCalls/System.getNextBytes<~lib/typedarray/Uint8Array>$33 (result i32)
   local.get $0
   i32.load
   local.set $3
   i32.const 0
   call $~lib/typedarray/Uint8Array#constructor
   drop
   i32.const 8
   i32.const 80
   call $~lib/rt/stub/__new
   local.tee $0
   i32.const 0
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.const 0
   call $~lib/rt/common/OBJECT#set:gcInfo
   local.get $0
   local.get $3
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   local.get $1
   call $~lib/rt/common/OBJECT#set:gcInfo
   local.get $0
   i32.const 3088
   call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
   local.set $0
   i32.const 304
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
   i32.load offset=4
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
   local.get $0
   i32.load offset=4
   local.get $0
   i32.load offset=8
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
   i32.load offset=4
   call $~lib/@koinos/sdk-as/assembly/env/index/env.invokeSystemCall
   local.tee $0
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
   i32.const 0
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
   call $~lib/typedarray/Uint32Array#__get
   call $~lib/typedarray/Uint8Array#slice
   call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkErrorCode
   i32.const 0
   local.get $0
   br_if $__inlined_func$~lib/@koinos/sdk-as/assembly/systemCalls/System.getNextBytes<~lib/typedarray/Uint8Array>$33
   drop
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
   i32.const 3120
   global.get $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
   call $~lib/typedarray/Uint32Array#__get
   call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>
   i32.load
  end
  local.set $1
  i32.const 0
  local.set $0
  local.get $1
  if
   i32.const 8
   i32.const 79
   call $~lib/rt/stub/__new
   local.tee $0
   i32.const 0
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.const 0
   call $~lib/rt/common/OBJECT#set:gcInfo
   local.get $0
   local.get $1
   i32.load offset=8
   call $~lib/rt/common/OBJECT#set:gcInfo
   local.get $1
   i32.load offset=4
   local.set $1
   i32.const 2
   global.set $~argumentsLength
   local.get $0
   local.get $1
   local.get $2
   call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
   call $~lib/rt/common/BLOCK#set:mmInfo
  end
  local.get $0
 )
 (func $assembly/Race/Race#list_picks (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  i32.const 0
  global.set $~argumentsLength
  i32.const 0
  i32.const 78
  i32.const 3056
  call $~lib/rt/__newArray
  local.set $3
  i32.const 4
  i32.const 76
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  local.get $3
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  i32.load offset=12
  if (result i32)
   local.get $1
   i32.load offset=12
   i32.const 100
   i32.gt_u
  else
   i32.const 1
  end
  if (result i32)
   i32.const 100
  else
   local.get $1
   i32.load offset=12
  end
  local.set $4
  local.get $1
  i64.load
  call $assembly/Race/raceBytes
  local.set $3
  local.get $1
  i32.load offset=8
  if (result i32)
   local.get $1
   i32.load offset=8
   local.tee $5
   i32.eqz
   if
    unreachable
   end
   local.get $5
   i32.load offset=8
   i32.const 25
   i32.eq
  else
   i32.const 0
  end
  if
   local.get $1
   i32.load offset=8
   local.tee $1
   i32.eqz
   if
    unreachable
   end
  else
   i32.const 25
   call $~lib/typedarray/Uint8Array#constructor
   local.set $1
  end
  local.get $3
  local.get $1
  call $assembly/Race/concat
  local.set $1
  loop $while-continue|0
   local.get $4
   local.get $2
   i32.load
   i32.load offset=12
   i32.gt_u
   if
    block $while-break|0
     local.get $0
     i32.load offset=8
     local.get $1
     call $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.pick_object>#getNext"
     local.tee $5
     if (result i32)
      local.get $5
      i32.load offset=4
     else
      i32.const 0
     end
     i32.eqz
     br_if $while-break|0
     local.get $5
     i32.load offset=4
     local.tee $1
     i32.eqz
     if
      unreachable
     end
     local.get $1
     i32.load offset=8
     i32.const 33
     i32.ne
     if (result i32)
      i32.const 0
     else
      local.get $1
      i32.const 0
      i32.const 8
      call $~lib/typedarray/Uint8Array#subarray
      local.get $3
      call $~lib/@koinos/sdk-as/assembly/util/arrays/Arrays.equal
     end
     i32.eqz
     br_if $while-break|0
     local.get $2
     i32.load
     local.set $6
     i32.const 1
     global.set $~argumentsLength
     local.get $1
     i32.const 8
     i32.const 2147483647
     call $~lib/typedarray/Uint8Array#slice
     local.set $7
     local.get $5
     i32.load
     local.set $8
     i32.const 8
     i32.const 77
     call $~lib/rt/stub/__new
     local.tee $5
     i32.const 0
     call $~lib/rt/common/BLOCK#set:mmInfo
     local.get $5
     i32.const 0
     call $~lib/rt/common/OBJECT#set:gcInfo
     local.get $5
     local.get $7
     call $~lib/rt/common/BLOCK#set:mmInfo
     local.get $5
     local.get $8
     call $~lib/rt/common/OBJECT#set:gcInfo
     local.get $6
     local.get $6
     i32.load offset=12
     local.tee $7
     i32.const 1
     i32.add
     local.tee $8
     i32.const 1
     call $~lib/array/ensureCapacity
     local.get $6
     i32.load offset=4
     local.get $7
     i32.const 2
     i32.shl
     i32.add
     local.get $5
     i32.store
     local.get $6
     local.get $8
     call $~lib/rt/common/OBJECT#set:rtId
     br $while-continue|0
    end
   end
  end
  local.get $2
 )
 (func $assembly/proto/race/race.list_picks_result.encode (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  i32.load
  local.set $0
  loop $for-loop|0
   local.get $2
   local.get $0
   i32.load offset=12
   i32.lt_s
   if
    local.get $1
    i32.const 10
    call $~lib/as-proto/assembly/Writer/Writer#uint32@override
    local.get $1
    call $~lib/as-proto/assembly/Writer/Writer#fork@override
    local.get $0
    local.get $2
    call $~lib/array/Array<~lib/typedarray/Uint8Array>#__get
    local.tee $3
    i32.load
    local.tee $4
    if
     local.get $1
     i32.const 10
     call $~lib/as-proto/assembly/Writer/Writer#uint32@override
     local.get $1
     local.get $4
     call $~lib/as-proto/assembly/Writer/Writer#bytes@override
    end
    local.get $3
    i32.load offset=4
    local.tee $3
    if
     local.get $1
     i32.const 18
     call $~lib/as-proto/assembly/Writer/Writer#uint32@override
     local.get $1
     call $~lib/as-proto/assembly/Writer/Writer#fork@override
     local.get $3
     local.get $1
     call $assembly/proto/race/race.pick_object.encode
     local.get $1
     call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
    end
    local.get $1
    call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
    local.get $2
    i32.const 1
    i32.add
    local.set $2
    br $for-loop|0
   end
  end
 )
 (func $assembly/proto/race/race.get_usage_arguments.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $3
  i32.const 4
  i32.const 85
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $3
   i32.lt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $1
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     local.get $2
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#bytes@override
     call $~lib/rt/common/BLOCK#set:mmInfo
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $assembly/proto/race/race.get_usage_result.encode (param $0 i32) (param $1 i32)
  local.get $0
  i64.load
  i64.const 0
  i64.ne
  if
   local.get $1
   i32.const 8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i64.load
   call $~lib/as-proto/assembly/Writer/Writer#uint64@override
  end
  local.get $0
  i32.load offset=8
  if
   local.get $1
   i32.const 16
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=8
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
  end
  local.get $0
  i32.load offset=12
  if
   local.get $1
   i32.const 24
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   local.get $0
   i32.load offset=12
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
  end
 )
 (func $assembly/proto/race/race.get_config_arguments.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $1
  i32.const 0
  call $~lib/rt/stub/__alloc
  local.set $2
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $1
   i32.lt_u
   if
    local.get $0
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $assembly/proto/race/race.set_config_arguments.decode (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $3
  i32.const 4
  i32.const 89
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $3
   i32.lt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $1
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     local.get $2
     local.get $0
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     call $assembly/proto/race/race.config.decode
     call $~lib/rt/common/BLOCK#set:mmInfo
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $assembly/proto/race/race.config_event.encode (param $0 i32) (param $1 i32)
  local.get $0
  i32.load
  local.tee $0
  if
   local.get $1
   i32.const 10
   call $~lib/as-proto/assembly/Writer/Writer#uint32@override
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#fork@override
   local.get $0
   local.get $1
   call $assembly/proto/race/race.config.encode
   local.get $1
   call $~lib/as-proto/assembly/Writer/Writer#ldelim@override
  end
 )
 (func $assembly/Race/Race#set_config (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  local.get $0
  i32.load offset=4
  call $~lib/@koinos/sdk-as/assembly/util/storage/Storage.Obj<assembly/proto/race/race.config>#get
  local.tee $2
  i32.eqz
  if
   unreachable
  end
  local.get $2
  i32.load
  call $assembly/Race/isAddress
  if
   local.get $2
   i32.load
   local.tee $2
   i32.eqz
   if
    unreachable
   end
  else
   local.get $0
   i32.load
   local.set $2
  end
  local.get $2
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.checkAuthority
  i32.const 3312
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i32.load
  i32.const 0
  i32.ne
  i32.const 3392
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i32.load
  local.tee $1
  i32.eqz
  if
   unreachable
  end
  local.get $1
  i32.load
  call $assembly/Race/isAddress
  i32.const 3456
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i32.load
  local.get $0
  i32.load
  call $~lib/@koinos/sdk-as/assembly/util/arrays/Arrays.equal
  i32.eqz
  i32.const 3520
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $1
  i32.load offset=8
  if (result i32)
   local.get $1
   i32.load offset=8
   i32.const 20
   i32.le_u
  else
   i32.const 0
  end
  i32.const 3648
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.require<bool>
  local.get $0
  i32.load offset=4
  local.tee $2
  i32.load
  global.get $~lib/@koinos/sdk-as/assembly/util/storage/DEFAULT_KEY
  local.get $1
  local.get $2
  i32.load offset=12
  call $"~lib/@koinos/sdk-as/assembly/systemCalls/System.putObject<~lib/typedarray/Uint8Array,assembly/proto/race/race.day_count>"
  i32.const 4
  i32.const 91
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  local.get $1
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 3808
  call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
  local.set $1
  i32.const 1
  i32.const 65
  i32.const 0
  call $~lib/rt/__newArray
  local.tee $2
  i32.load offset=4
  drop
  local.get $2
  local.get $0
  i32.load
  call $~lib/array/Array<~lib/typedarray/Uint8Array>#__set
  i32.const 3744
  local.get $1
  local.get $2
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.event
  i32.const 0
  call $~lib/rt/stub/__alloc
 )
 (func $assembly/index/main (result i32)
  (local $0 i32)
  (local $1 i64)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.getArguments
  local.set $3
  i32.const 1024
  call $~lib/typedarray/Uint8Array#constructor
  local.set $0
  call $assembly/Race/Race#constructor
  local.set $4
  block $break|0
   block $case6|0
    block $case5|0
     block $case4|0
      block $case3|0
       block $case2|0
        block $case1|0
         local.get $3
         i32.load
         local.tee $2
         i32.const -1931264916
         i32.ne
         if
          local.get $2
          i32.const -211753245
          i32.eq
          br_if $case1|0
          local.get $2
          i32.const 2118033200
          i32.eq
          br_if $case2|0
          local.get $2
          i32.const 1236253562
          i32.eq
          br_if $case3|0
          local.get $2
          i32.const -1135620652
          i32.eq
          br_if $case4|0
          local.get $2
          i32.const 1269140617
          i32.eq
          br_if $case5|0
          br $case6|0
         end
         local.get $3
         i32.load offset=4
         local.set $0
         i32.const 2
         global.set $~argumentsLength
         local.get $4
         local.get $0
         i32.const 2352
         call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
         call $assembly/Race/Race#pick
         i32.const 2928
         call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
         local.set $0
         br $break|0
        end
        local.get $3
        i32.load offset=4
        local.set $0
        i32.const 2
        global.set $~argumentsLength
        local.get $0
        i32.const 2960
        call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
        local.set $0
        i32.const 4
        i32.const 72
        call $~lib/rt/stub/__new
        local.tee $2
        i32.const 0
        call $~lib/rt/common/BLOCK#set:mmInfo
        local.get $2
        i32.const 0
        call $~lib/rt/common/BLOCK#set:mmInfo
        local.get $0
        i32.load
        call $assembly/Race/isAddress
        if
         local.get $4
         i32.load offset=8
         local.set $3
         local.get $0
         i64.load offset=8
         local.set $1
         local.get $0
         i32.load
         local.tee $0
         i32.eqz
         if
          unreachable
         end
         local.get $3
         local.get $1
         local.get $0
         call $assembly/Race/pickKey
         call $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.pick_object>#get"
         local.tee $0
         if (result i32)
          local.get $0
          i32.load
         else
          i32.const 0
         end
         if (result i32)
          local.get $0
          i32.load
          local.tee $3
          i32.eqz
          if
           unreachable
          end
          local.get $3
          i32.load offset=8
          i32.const 0
          i32.gt_s
         else
          i32.const 0
         end
         if
          local.get $2
          local.get $0
          call $~lib/rt/common/BLOCK#set:mmInfo
         end
        end
        local.get $2
        i32.const 2992
        call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
        local.set $0
        br $break|0
       end
       local.get $3
       i32.load offset=4
       local.set $0
       i32.const 2
       global.set $~argumentsLength
       local.get $4
       local.get $0
       i32.const 3024
       call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
       call $assembly/Race/Race#list_picks
       i32.const 3152
       call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
       local.set $0
       br $break|0
      end
      local.get $3
      i32.load offset=4
      local.set $0
      i32.const 2
      global.set $~argumentsLength
      local.get $0
      i32.const 3184
      call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
      local.set $0
      local.get $4
      i32.load offset=4
      call $~lib/@koinos/sdk-as/assembly/util/storage/Storage.Obj<assembly/proto/race/race.config>#get
      local.tee $2
      i32.eqz
      if
       unreachable
      end
      call $~lib/@koinos/sdk-as/assembly/systemCalls/System.getHeadInfo
      i64.load offset=8
      i64.const 86400000
      i64.div_u
      local.set $1
      local.get $0
      i32.load
      call $assembly/Race/isAddress
      if (result i32)
       local.get $4
       i32.load offset=12
       local.set $3
       local.get $0
       i32.load
       local.tee $0
       i32.eqz
       if
        unreachable
       end
       local.get $3
       local.get $0
       call $"~lib/@koinos/sdk-as/assembly/util/storage/Storage.Map<~lib/typedarray/Uint8Array,assembly/proto/race/race.pick_object>#get"
       local.tee $0
       i32.eqz
       if
        unreachable
       end
       local.get $1
       local.get $0
       i64.load
       i64.eq
       if (result i32)
        local.get $0
        i32.load offset=8
       else
        i32.const 0
       end
      else
       i32.const 0
      end
      local.set $0
      local.get $2
      i32.load offset=8
      local.set $2
      i32.const 16
      call $~lib/rt/stub/__alloc
      local.tee $3
      i64.const 0
      call $assembly/proto/race/race.day_count#set:day
      local.get $3
      i32.const 0
      call $~lib/rt/common/OBJECT#set:gcInfo2
      local.get $3
      i32.const 0
      call $~lib/rt/common/OBJECT#set:rtId
      local.get $3
      local.get $1
      call $assembly/proto/race/race.day_count#set:day
      local.get $3
      local.get $0
      call $~lib/rt/common/OBJECT#set:gcInfo2
      local.get $3
      local.get $2
      call $~lib/rt/common/OBJECT#set:rtId
      local.get $3
      i32.const 3216
      call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
      local.set $0
      br $break|0
     end
     local.get $3
     i32.load offset=4
     local.set $0
     i32.const 2
     global.set $~argumentsLength
     local.get $0
     i32.const 3248
     call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
     drop
     local.get $4
     i32.load offset=4
     call $~lib/@koinos/sdk-as/assembly/util/storage/Storage.Obj<assembly/proto/race/race.config>#get
     local.tee $0
     i32.eqz
     if
      unreachable
     end
     local.get $0
     i32.const 2096
     call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
     local.set $0
     br $break|0
    end
    local.get $3
    i32.load offset=4
    local.set $0
    i32.const 2
    global.set $~argumentsLength
    local.get $4
    local.get $0
    i32.const 3280
    call $~lib/as-proto/assembly/Protobuf/Protobuf.decode<~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.error_data>@varargs
    call $assembly/Race/Race#set_config
    i32.const 2928
    call $~lib/as-proto/assembly/Protobuf/Protobuf.encode<~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_arguments_arguments>
    local.set $0
    br $break|0
   end
   i32.const 1
   i32.const 0
   call $~lib/@koinos/sdk-as/assembly/systemCalls/System.exit
  end
  i32.const 0
  local.get $0
  call $~lib/@koinos/sdk-as/assembly/systemCalls/System.exit
  i32.const 0
 )
 (func $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint32 (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  local.get $0
  i32.load
  local.set $1
  local.get $0
  local.get $0
  i32.load
  i32.const 1
  i32.add
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.load
  local.get $0
  i32.load offset=4
  i32.gt_u
  if
   unreachable
  end
  local.get $1
  i32.load8_u
  local.tee $2
  i32.const 127
  i32.and
  local.set $1
  block $folding-inner0
   local.get $2
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i32.load8_u
   local.tee $2
   i32.const 127
   i32.and
   i32.const 7
   i32.shl
   i32.or
   local.set $1
   local.get $2
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i32.load8_u
   local.tee $2
   i32.const 127
   i32.and
   i32.const 14
   i32.shl
   i32.or
   local.set $1
   local.get $2
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i32.load8_u
   local.tee $2
   i32.const 127
   i32.and
   i32.const 21
   i32.shl
   i32.or
   local.set $1
   local.get $2
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i32.load8_u
   local.tee $2
   i32.const 15
   i32.and
   i32.const 28
   i32.shl
   i32.or
   local.set $1
   local.get $2
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $2
   i32.load8_u
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $2
   i32.load8_u
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $2
   i32.load8_u
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $2
   i32.load8_u
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $2
   i32.load8_u
   i32.const 128
   i32.lt_u
   br_if $folding-inner0
  end
  local.get $1
 )
 (func $~lib/as-proto/assembly/internal/FixedReader/FixedReader#bytes (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint32
  local.tee $1
  call $~lib/typedarray/Uint8Array#constructor
  local.tee $2
  i32.load offset=4
  local.set $3
  local.get $0
  i32.load
  local.set $4
  local.get $0
  local.get $0
  i32.load
  local.get $1
  i32.add
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.load
  local.get $0
  i32.load offset=4
  i32.gt_u
  if
   unreachable
  end
  local.get $3
  local.get $4
  local.get $1
  call $~lib/memory/memory.copy
  local.get $2
 )
 (func $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skip (param $0 i32) (param $1 i32)
  local.get $1
  if
   local.get $0
   i32.load
   drop
   local.get $0
   local.get $0
   i32.load
   local.get $1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
  else
   loop $while-continue|0
    local.get $0
    i32.load
    local.set $1
    local.get $0
    local.get $0
    i32.load
    i32.const 1
    i32.add
    call $~lib/rt/common/BLOCK#set:mmInfo
    local.get $0
    i32.load
    local.get $0
    i32.load offset=4
    i32.gt_u
    if
     unreachable
    end
    local.get $1
    i32.load8_u
    i32.const 128
    i32.and
    br_if $while-continue|0
   end
  end
 )
 (func $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skipType (param $0 i32) (param $1 i32)
  block $break|0
   block $case5|0
    block $case4|0
     block $case3|0
      block $case2|0
       block $case1|0
        block $case0|0
         local.get $1
         br_table $case0|0 $case1|0 $case2|0 $case3|0 $case5|0 $case4|0 $case5|0
        end
        local.get $0
        i32.const 0
        call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skip
        br $break|0
       end
       local.get $0
       i32.const 8
       call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skip
       br $break|0
      end
      local.get $0
      local.get $0
      call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint32
      call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skip
      br $break|0
     end
     loop $while-continue|1
      local.get $0
      call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint32
      i32.const 7
      i32.and
      local.tee $1
      i32.const 4
      i32.ne
      if
       local.get $0
       local.get $1
       call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skipType
       br $while-continue|1
      end
     end
     br $break|0
    end
    local.get $0
    i32.const 4
    call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skip
    br $break|0
   end
   unreachable
  end
 )
 (func $~lib/array/Array<i32>#__get (param $0 i32) (param $1 i32) (result i32)
  local.get $1
  local.get $0
  i32.load offset=12
  i32.ge_u
  if
   unreachable
  end
  local.get $0
  i32.load offset=4
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  i32.load
 )
 (func $~lib/array/Array<u32>#push (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  local.get $0
  local.get $0
  i32.load offset=12
  local.tee $2
  i32.const 1
  i32.add
  local.tee $3
  i32.const 1
  call $~lib/array/ensureCapacity
  local.get $0
  i32.load offset=4
  local.get $2
  i32.const 2
  i32.shl
  i32.add
  local.get $1
  i32.store
  local.get $0
  local.get $3
  call $~lib/rt/common/OBJECT#set:rtId
 )
 (func $~lib/as-proto/assembly/internal/FixedSizer/FixedSizer#ldelim (param $0 i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  local.get $0
  i32.load offset=4
  i32.load offset=12
  if (result i32)
   local.get $0
   i32.load offset=12
   i32.load offset=12
  else
   i32.const 0
  end
  i32.eqz
  if
   unreachable
  end
  local.get $0
  i32.load
  local.set $1
  local.get $0
  i32.load offset=4
  local.tee $3
  i32.load offset=12
  local.tee $2
  i32.const 0
  i32.le_s
  if
   unreachable
  end
  local.get $3
  i32.load offset=4
  local.get $2
  i32.const 1
  i32.sub
  local.tee $4
  i32.const 2
  i32.shl
  i32.add
  i32.load
  local.set $2
  local.get $3
  local.get $4
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $0
  i32.load offset=12
  local.tee $4
  i32.load offset=12
  local.tee $3
  i32.const 0
  i32.le_s
  if
   unreachable
  end
  local.get $4
  i32.load offset=4
  local.get $3
  i32.const 1
  i32.sub
  local.tee $5
  i32.const 2
  i32.shl
  i32.add
  i32.load
  local.set $3
  local.get $4
  local.get $5
  call $~lib/rt/common/OBJECT#set:rtId
  local.get $3
  local.get $0
  i32.load offset=8
  local.tee $4
  i32.load offset=12
  i32.ge_u
  if
   local.get $3
   i32.const 0
   i32.lt_s
   if
    unreachable
   end
   local.get $4
   local.get $3
   i32.const 1
   i32.add
   local.tee $5
   i32.const 1
   call $~lib/array/ensureCapacity
   local.get $4
   local.get $5
   call $~lib/rt/common/OBJECT#set:rtId
  end
  local.get $4
  i32.load offset=4
  local.get $3
  i32.const 2
  i32.shl
  i32.add
  local.get $1
  local.get $2
  i32.sub
  local.tee $1
  i32.store
  local.get $0
  local.get $0
  i32.load
  i32.const 1
  i32.const 2
  i32.const 3
  i32.const 4
  i32.const 5
  local.get $1
  i32.const 268435456
  i32.lt_u
  select
  local.get $1
  i32.const 2097152
  i32.lt_u
  select
  local.get $1
  i32.const 16384
  i32.lt_u
  select
  local.get $1
  i32.const 128
  i32.lt_u
  select
  i32.add
  call $~lib/rt/common/BLOCK#set:mmInfo
 )
 (func $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint64 (param $0 i32) (result i64)
  (local $1 i64)
  (local $2 i32)
  (local $3 i64)
  local.get $0
  i32.load
  local.set $2
  local.get $0
  local.get $0
  i32.load
  i32.const 1
  i32.add
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  i32.load
  local.get $0
  i32.load offset=4
  i32.gt_u
  if
   unreachable
  end
  local.get $2
  i64.load8_u
  local.tee $3
  i64.const 127
  i64.and
  local.set $1
  block $folding-inner0
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 7
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 14
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 21
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 28
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 35
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 42
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 49
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   local.tee $3
   i64.const 127
   i64.and
   i64.const 56
   i64.shl
   i64.or
   local.set $1
   local.get $3
   i64.const 128
   i64.lt_u
   br_if $folding-inner0
   local.get $0
   i32.load
   local.set $2
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   i32.gt_u
   if
    unreachable
   end
   local.get $1
   local.get $2
   i64.load8_u
   i64.const 1
   i64.and
   i64.const 63
   i64.shl
   i64.or
   local.set $1
  end
  local.get $1
 )
 (func $~lib/as-proto/assembly/Reader/Reader#uint32@override (param $0 i32) (result i32)
  local.get $0
  i32.const 8
  i32.sub
  i32.load
  i32.const 10
  i32.eq
  if
   local.get $0
   call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint32
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Reader/Reader#skipType@override (param $0 i32) (param $1 i32)
  local.get $0
  i32.const 8
  i32.sub
  i32.load
  i32.const 10
  i32.eq
  if
   local.get $0
   local.get $1
   call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#skipType
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#uint32@override (param $0 i32) (param $1 i32)
  (local $2 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $2
    i32.const 4
    i32.ne
    if
     local.get $2
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    loop $while-continue|0
     local.get $1
     i32.const 127
     i32.gt_u
     if
      local.get $0
      local.get $0
      i32.load offset=4
      local.tee $2
      i32.const 1
      i32.add
      call $~lib/rt/common/OBJECT#set:gcInfo
      local.get $2
      local.get $1
      i32.const 127
      i32.and
      i32.const 128
      i32.or
      i32.store8
      local.get $1
      i32.const 7
      i32.shr_u
      local.set $1
      br $while-continue|0
     end
    end
    local.get $0
    local.get $0
    i32.load offset=4
    local.tee $0
    i32.const 1
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    local.get $0
    local.get $1
    i32.store8
    return
   end
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.const 2
   i32.const 3
   i32.const 4
   i32.const 5
   local.get $1
   i32.const 268435456
   i32.lt_u
   select
   local.get $1
   i32.const 2097152
   i32.lt_u
   select
   local.get $1
   i32.const 16384
   i32.lt_u
   select
   local.get $1
   i32.const 128
   i32.lt_u
   select
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#int32@override (param $0 i32) (param $1 i32)
  (local $2 i64)
  (local $3 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $3
    i32.const 4
    i32.ne
    if
     local.get $3
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    local.get $1
    i32.const 0
    i32.lt_s
    if
     local.get $1
     i64.extend_i32_s
     local.set $2
     loop $while-continue|0
      local.get $2
      i64.const 127
      i64.gt_u
      if
       local.get $0
       local.get $0
       i32.load offset=4
       local.tee $1
       i32.const 1
       i32.add
       call $~lib/rt/common/OBJECT#set:gcInfo
       local.get $1
       local.get $2
       i64.const 127
       i64.and
       i64.const 128
       i64.or
       i64.store8
       local.get $2
       i64.const 7
       i64.shr_u
       local.set $2
       br $while-continue|0
      end
     end
     local.get $0
     local.get $0
     i32.load offset=4
     local.tee $0
     i32.const 1
     i32.add
     call $~lib/rt/common/OBJECT#set:gcInfo
     local.get $0
     local.get $2
     i64.store8
    else
     loop $while-continue|1
      local.get $1
      i32.const 127
      i32.gt_u
      if
       local.get $0
       local.get $0
       i32.load offset=4
       local.tee $3
       i32.const 1
       i32.add
       call $~lib/rt/common/OBJECT#set:gcInfo
       local.get $3
       local.get $1
       i32.const 127
       i32.and
       i32.const 128
       i32.or
       i32.store8
       local.get $1
       i32.const 7
       i32.shr_u
       local.set $1
       br $while-continue|1
      end
     end
     local.get $0
     local.get $0
     i32.load offset=4
     local.tee $0
     i32.const 1
     i32.add
     call $~lib/rt/common/OBJECT#set:gcInfo
     local.get $0
     local.get $1
     i32.store8
    end
    return
   end
   local.get $1
   i32.const 0
   i32.lt_s
   if
    local.get $0
    local.get $0
    i32.load
    i32.const 10
    i32.add
    call $~lib/rt/common/BLOCK#set:mmInfo
   else
    local.get $0
    local.get $0
    i32.load
    i32.const 1
    i32.const 2
    i32.const 3
    i32.const 4
    i32.const 5
    local.get $1
    i32.const 268435456
    i32.lt_u
    select
    local.get $1
    i32.const 2097152
    i32.lt_u
    select
    local.get $1
    i32.const 16384
    i32.lt_u
    select
    local.get $1
    i32.const 128
    i32.lt_u
    select
    i32.add
    call $~lib/rt/common/BLOCK#set:mmInfo
   end
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#fork@override (param $0 i32)
  (local $1 i32)
  (local $2 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $1
    i32.const 4
    i32.ne
    if
     local.get $1
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    local.get $0
    i32.load offset=12
    local.get $0
    i32.load
    i32.load offset=8
    i32.load offset=12
    i32.ge_s
    if (result i32)
     i32.const 0
    else
     local.get $0
     i32.load
     i32.load offset=8
     local.set $1
     local.get $0
     local.get $0
     i32.load offset=12
     local.tee $2
     i32.const 1
     i32.add
     call $~lib/rt/common/OBJECT#set:rtId
     local.get $1
     local.get $2
     call $~lib/array/Array<i32>#__get
    end
    local.set $1
    loop $while-continue|0
     local.get $1
     i32.const 127
     i32.gt_u
     if
      local.get $0
      local.get $0
      i32.load offset=4
      local.tee $2
      i32.const 1
      i32.add
      call $~lib/rt/common/OBJECT#set:gcInfo
      local.get $2
      local.get $1
      i32.const 127
      i32.and
      i32.const 128
      i32.or
      i32.store8
      local.get $1
      i32.const 7
      i32.shr_u
      local.set $1
      br $while-continue|0
     end
    end
    local.get $0
    local.get $0
    i32.load offset=4
    local.tee $0
    i32.const 1
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    local.get $0
    local.get $1
    i32.store8
    return
   end
   local.get $0
   i32.load offset=4
   local.get $0
   i32.load
   call $~lib/array/Array<u32>#push
   local.get $0
   i32.load offset=12
   local.get $0
   i32.load offset=8
   i32.load offset=12
   call $~lib/array/Array<u32>#push
   local.get $0
   i32.load offset=8
   i32.const 0
   call $~lib/array/Array<u32>#push
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#bytes@override (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $2
    i32.const 4
    i32.ne
    if
     local.get $2
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    local.get $1
    i32.load offset=8
    local.set $2
    loop $while-continue|0
     local.get $2
     i32.const 127
     i32.gt_u
     if
      local.get $0
      local.get $0
      i32.load offset=4
      local.tee $3
      i32.const 1
      i32.add
      call $~lib/rt/common/OBJECT#set:gcInfo
      local.get $3
      local.get $2
      i32.const 127
      i32.and
      i32.const 128
      i32.or
      i32.store8
      local.get $2
      i32.const 7
      i32.shr_u
      local.set $2
      br $while-continue|0
     end
    end
    local.get $0
    local.get $0
    i32.load offset=4
    local.tee $3
    i32.const 1
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    local.get $3
    local.get $2
    i32.store8
    local.get $0
    i32.load offset=4
    local.get $1
    i32.load offset=4
    local.get $1
    i32.load offset=8
    call $~lib/memory/memory.copy
    local.get $0
    local.get $0
    i32.load offset=4
    local.get $1
    i32.load offset=8
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    return
   end
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.const 2
   i32.const 3
   i32.const 4
   i32.const 5
   local.get $1
   i32.load offset=8
   local.tee $2
   i32.const 268435456
   i32.lt_u
   select
   local.get $2
   i32.const 2097152
   i32.lt_u
   select
   local.get $2
   i32.const 16384
   i32.lt_u
   select
   local.get $2
   i32.const 128
   i32.lt_u
   select
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   local.get $0
   i32.load
   local.get $1
   i32.load offset=8
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#string@override (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $2
    i32.const 4
    i32.ne
    if
     local.get $2
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    local.get $0
    i32.load offset=12
    local.get $0
    i32.load
    i32.load offset=8
    i32.load offset=12
    i32.ge_s
    if (result i32)
     i32.const 0
    else
     local.get $0
     i32.load
     i32.load offset=8
     local.set $2
     local.get $0
     local.get $0
     i32.load offset=12
     local.tee $3
     i32.const 1
     i32.add
     call $~lib/rt/common/OBJECT#set:rtId
     local.get $2
     local.get $3
     call $~lib/array/Array<i32>#__get
    end
    local.tee $3
    local.set $2
    loop $while-continue|0
     local.get $2
     i32.const 127
     i32.gt_u
     if
      local.get $0
      local.get $0
      i32.load offset=4
      local.tee $4
      i32.const 1
      i32.add
      call $~lib/rt/common/OBJECT#set:gcInfo
      local.get $4
      local.get $2
      i32.const 127
      i32.and
      i32.const 128
      i32.or
      i32.store8
      local.get $2
      i32.const 7
      i32.shr_u
      local.set $2
      br $while-continue|0
     end
    end
    local.get $0
    local.get $0
    i32.load offset=4
    local.tee $4
    i32.const 1
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    local.get $4
    local.get $2
    i32.store8
    local.get $1
    call $~lib/string/String#get:length
    local.set $2
    local.get $0
    i32.load offset=4
    local.set $4
    i32.const 3
    global.set $~argumentsLength
    local.get $1
    local.get $2
    local.get $4
    call $~lib/string/String.UTF8.encodeUnsafe
    local.get $0
    local.get $3
    local.get $0
    i32.load offset=4
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    return
   end
   local.get $1
   i32.const 0
   call $~lib/string/String.UTF8.byteLength
   local.set $1
   local.get $0
   i32.load offset=8
   local.get $1
   call $~lib/array/Array<u32>#push
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.const 2
   i32.const 3
   i32.const 4
   i32.const 5
   local.get $1
   i32.const 268435456
   i32.lt_u
   select
   local.get $1
   i32.const 2097152
   i32.lt_u
   select
   local.get $1
   i32.const 16384
   i32.lt_u
   select
   local.get $1
   i32.const 128
   i32.lt_u
   select
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   local.get $0
   i32.load
   local.get $1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#ldelim@override (param $0 i32)
  (local $1 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $1
    i32.const 4
    i32.ne
    if
     local.get $1
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    return
   end
   local.get $0
   call $~lib/as-proto/assembly/internal/FixedSizer/FixedSizer#ldelim
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Reader/Reader#bytes@override (param $0 i32) (result i32)
  local.get $0
  i32.const 8
  i32.sub
  i32.load
  i32.const 10
  i32.eq
  if
   local.get $0
   call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#bytes
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Reader/Reader#bool@override (param $0 i32) (result i32)
  local.get $0
  i32.const 8
  i32.sub
  i32.load
  i32.const 10
  i32.eq
  if
   local.get $0
   call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint32
   i32.const 0
   i32.ne
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#bool@override (param $0 i32) (param $1 i32)
  (local $2 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $2
    i32.const 4
    i32.ne
    if
     local.get $2
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    local.get $0
    i32.load offset=4
    local.get $1
    i32.eqz
    i32.eqz
    i32.store8
    local.get $0
    local.get $0
    i32.load offset=4
    i32.const 1
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    return
   end
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Reader/Reader#uint64@override (param $0 i32) (result i64)
  local.get $0
  i32.const 8
  i32.sub
  i32.load
  i32.const 10
  i32.eq
  if
   local.get $0
   call $~lib/as-proto/assembly/internal/FixedReader/FixedReader#varint64
   return
  end
  unreachable
 )
 (func $~lib/as-proto/assembly/Writer/Writer#uint64@override (param $0 i32) (param $1 i64)
  (local $2 i32)
  block $default
   block $case1
    local.get $0
    i32.const 8
    i32.sub
    i32.load
    local.tee $2
    i32.const 4
    i32.ne
    if
     local.get $2
     i32.const 6
     i32.eq
     br_if $case1
     br $default
    end
    loop $while-continue|0
     local.get $1
     i64.const 127
     i64.gt_u
     if
      local.get $0
      local.get $0
      i32.load offset=4
      local.tee $2
      i32.const 1
      i32.add
      call $~lib/rt/common/OBJECT#set:gcInfo
      local.get $2
      local.get $1
      i64.const 127
      i64.and
      i64.const 128
      i64.or
      i64.store8
      local.get $1
      i64.const 7
      i64.shr_u
      local.set $1
      br $while-continue|0
     end
    end
    local.get $0
    local.get $0
    i32.load offset=4
    local.tee $0
    i32.const 1
    i32.add
    call $~lib/rt/common/OBJECT#set:gcInfo
    local.get $0
    local.get $1
    i64.store8
    return
   end
   local.get $0
   local.get $0
   i32.load
   i32.const 1
   i32.const 2
   i32.const 3
   i32.const 4
   i32.const 5
   i32.const 6
   i32.const 7
   i32.const 8
   i32.const 9
   i32.const 10
   local.get $1
   i64.const -9223372036854775808
   i64.lt_u
   select
   local.get $1
   i64.const 72057594037927936
   i64.lt_u
   select
   local.get $1
   i64.const 562949953421312
   i64.lt_u
   select
   local.get $1
   i64.const 4398046511104
   i64.lt_u
   select
   local.get $1
   i64.const 34359738368
   i64.lt_u
   select
   local.get $1
   i64.const 268435456
   i64.lt_u
   select
   local.get $1
   i64.const 2097152
   i64.lt_u
   select
   local.get $1
   i64.const 16384
   i64.lt_u
   select
   local.get $1
   i64.const 128
   i64.lt_u
   select
   i32.add
   call $~lib/rt/common/BLOCK#set:mmInfo
   return
  end
  unreachable
 )
 (func $~start
  global.get $~started
  if
   return
  end
  i32.const 1
  global.set $~started
  call $start:~lib/as-proto/index
  i32.const 1
  global.set $~argumentsLength
  i32.const 1
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  i32.const 0
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#constructor
  drop
  i32.const 1
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  i32.const 1
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#constructor
  drop
  i32.const 1
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  i32.const 2
  call $~lib/@koinos/proto-as/assembly/koinos/chain/chain/chain.object_space#constructor
  drop
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  global.set $~lib/@koinos/sdk-as/assembly/util/storage/DEFAULT_KEY
  i32.const 1024
  global.set $~lib/@koinos/sdk-as/assembly/systemCalls/System.MAX_BUFFER_SIZE
  i32.const 1024
  call $~lib/typedarray/Uint8Array#constructor
  global.set $~lib/@koinos/sdk-as/assembly/systemCalls/System.SYSTEM_CALL_BUFFER
  i32.const 12
  i32.const 13
  call $~lib/rt/stub/__new
  i32.const 1
  i32.const 2
  call $~lib/arraybuffer/ArrayBufferView#constructor
  global.set $~lib/@koinos/sdk-as/assembly/systemCalls/System.RETURN_BYTES
  call $assembly/index/main
  drop
 )
 (func $byn$mgfn-shared$~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_contract_id_result.decode (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $1
   local.get $0
   i32.load
   i32.add
  end
  local.set $3
  i32.const 0
  global.set $~argumentsLength
  i32.const 0
  call $~lib/typedarray/Uint8Array#constructor
  local.set $4
  i32.const 4
  local.get $2
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $1
  local.get $4
  call $~lib/rt/common/BLOCK#set:mmInfo
  loop $while-continue|0
   local.get $3
   local.get $0
   i32.load
   i32.gt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $4
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     local.get $1
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#bytes@override
     call $~lib/rt/common/BLOCK#set:mmInfo
     br $while-continue|0
    end
    local.get $0
    local.get $4
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $1
 )
 (func $byn$mgfn-shared$~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.get_object_result.decode (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  local.get $1
  i32.const 0
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load offset=4
  else
   local.get $0
   i32.load
   local.get $1
   i32.add
  end
  local.set $4
  i32.const 4
  local.get $2
  call $~lib/rt/stub/__new
  local.tee $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $3
  i32.const 0
  call $~lib/rt/common/BLOCK#set:mmInfo
  loop $while-continue|0
   local.get $0
   i32.load
   local.get $4
   i32.lt_u
   if
    local.get $0
    call $~lib/as-proto/assembly/Reader/Reader#uint32@override
    local.tee $1
    i32.const 3
    i32.shr_u
    i32.const 1
    i32.eq
    if
     local.get $3
     local.get $0
     local.get $0
     call $~lib/as-proto/assembly/Reader/Reader#uint32@override
     call $~lib/@koinos/proto-as/assembly/koinos/chain/system_calls/system_calls.database_object.decode
     call $~lib/rt/common/BLOCK#set:mmInfo
     br $while-continue|0
    end
    local.get $0
    local.get $1
    i32.const 7
    i32.and
    call $~lib/as-proto/assembly/Reader/Reader#skipType@override
    br $while-continue|0
   end
  end
  local.get $3
 )
)

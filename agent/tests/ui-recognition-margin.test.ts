import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Observation} from '../src/core/protocol.js';
import {uiStateRecognized} from '../src/actions/ui-recognition.js';
function observation():Observation {return {protocol:'wow-agent',version:1,type:'observation',run_id:'margin-test',id:'fresh',at_ms:10,observation_seq:1,window:null,artifacts:[],fields:{'ui.state':{status:'known',value:{},source:'cv',captured_at_ms:10,source_observation_id:'fresh'},'ui.recognition':{status:'known',source:'cv',captured_at_ms:10,source_observation_id:'fresh',value:{status:'known',confidence_basis:'match_margin_v1',modal_status:'unknown',match_margin:{positive_distance:.6,acceptance_threshold:1,next_state_distance:2}}}}};}
test('a current passing native distance is not compared to model probability .95',()=>{assert.equal(uiStateRecognized(observation(),.4),true);});
test('a foreign recognition, competing match or modal cannot bypass a low margin',()=>{const o=observation(),f=o.fields['ui.recognition']!;f.source_observation_id='old';assert.equal(uiStateRecognized(o,.99),false);f.source_observation_id='fresh';const value=f.value as Record<string,any>;value.match_margin.next_state_distance=.9;assert.equal(uiStateRecognized(o,.99),false);value.match_margin.next_state_distance=2;value.modal_status='present';assert.equal(uiStateRecognized(o,.99),false);});

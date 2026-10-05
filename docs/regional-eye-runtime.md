# 分区眼运行与证据契约

更新：2026-10-05。首版实现源码、严格协议、冻结回放与离屏识别；不把合成图测试当正式服精度或20Hz验收。当前客户端真实profile与本地OCR权重尚未验收。

## 同帧流水线

WinEye只调用一次PrintWindow，既有detectors与RegionVision共享同一原Bitmap。`--artifact-format png`把同帧无损存档；默认仍JPEG。分区输出是可选`sample.regions`/`offline_result.regions`，未提供region配置时既有调用不受影响。

启动选项：`--region-profile <绝对Windows JSON路径> --region-context <绝对Windows JSON路径>`必须成对。TS `EyeClientOptions.regionProfileWindowsPath/regionContextWindowsPath`传入；classify也支持同样参数，离线分类不能称实时截图。

原生构建需要InputCommon.cs、EyeVision.cs、NpcVision.cs、**RegionVision.cs**、WinEye.cs。新增模块无截屏、输入、模型或网络调用。

## Profile与识别

唯一JSON格式源是`protocol/regional-eye-v1.schema.json`。profile包括branch/expansion/patch/build/region/locale、客户区物理尺寸、DPI、UI缩放、layout/font、插件集合SHA；context必须完全匹配。serve的DPI来自GetDpiForWindow，不能取得时不默认96。

区域按父先子后的顺序声明，每区有module/id/parent_id/roi/elements。支持player、target、cast、actionbar、quest、dialog、inventory、minimap、blocking、world；并不附带一个可直接套用所有角色的已校准HUD布局。离屏fixture覆盖前九模块，未校准区域明确unknown。

固定ROI没有visibility或anchor时，presence保持unknown。anchor是在有界search内匹配SHA固定PNG模板；歧义、缺失、越界不能当找到容器。模板资源不能路径穿越、符号链接或SHA不符。全profile最多64个元素，单锚点最多4096候选、总锚点比较像素有硬上限。

元素detector：

- `color_fraction`：RGB闭区间像素比例，按显式比例阈值给布尔结果。
- `fill_bar`：横/纵向、正/反向连续填充比例；断裂后又有填充时输出unknown。
- `template`：明确present/absent/occluded模板、最大距离与最小margin；未满足输出unknown。
- `template_labels`：多个带label的实际PNG模板，匹配才返回字符串；可校准运动模式等，不能由profile常量直接制造已知事实。
- `geometry`：已确认可见容器内的物理像素矩形。
- `ocr`：原生输出unavailable/local_ocr_required，交给本地worker；不会伪标文字为CV。

presence区分present、absent、occluded、unknown、unsupported。只有独立absent模板匹配才报告absent；找不到anchor仍是unknown。可见blocking容器覆盖区域时立即失效，父容器失效传播到子区域；未知遮挡没有万能检测保证。

## 缓存、源时间与原子字段

每区hash是原RGB字节SHA；PNG母图SHA是编码文件SHA，两者用途不同。ROI移动、hash变化、scope变化、遮挡/隐藏会失效缓存。

普通区域复用原解析结果，保留`source_frame_id/parsed_at_qpc_ms`。`pixels_verified_qpc_ms`是当前同像素验证时间。RegionState将源QPC关联到WSL请求/接收括号，不直接相减两种时钟；原`captured_at_ms/source_observation_id`不因缓存复用刷新。`region_evidence`另外保存验证观察和时间，原源TTL到期仍unknown。

动作关键区域禁用解析结果缓存，每帧实际重检测：player.movement_mode、input.mouse_mode、ui.layout_id、target.dead/alive/signature/hostile/attackable/lootable、combat.ability.*、dialog.*、navigation.*、hazard.*、loot.*、quest.*。裁切/hash仍共享。普通文字OCR继续保留原时间。

`RegionState.apply(batch,bracket,observationId,artifactId?)`返回RegionObservation，包括原子fields、regions及appeared/disappeared/changed/invalidated事件。EyeState自动接入原生区域字段；已校准旧detectors优先，明确区域遮挡可使对应旧字段失效。失败/缺失区域不能继续保持上一帧known。

`region.<id>.presence`来自真实可见性检测。`ui.layout_id`只有匹配scope且HUD区域有实际anchor/visibility证据才known。input.mouse_mode和player.movement_mode没有默认推断；必须有实际元素证据，否则动作模块阻塞。

`buildObjectViews(fields)`保留每个UnitView/ActionSlot/QuestEntry/BagSlot/MapMarker叶字段证据；UI_ref不升级为游戏GUID、技能/物品ID或世界坐标。`composeDialogueElements(fields,obsId)`要求当前同帧CV的rectangle、role、enabled和layout；文字/OCR不能授权点击，缺证据返回unknown。未知quest/reward ID不制造关联。

`VisualTracks.update(scope,frame,detections,visible)`只给视觉连续ID；同名多目标、遮挡或layout改变使绑定失效，entity_guid恒null。尚未实现通用世界姓名板检测或可靠导航定位。

## 本地OCR与局部Seed

`LocalOcrClient.recognize(request)`启动后复用同一Python JSONL worker。请求格式源是`protocol/local-ocr-v1.schema.json`；校验请求/模型/frame/image SHA、实际PNG签名和尺寸、多ROI边界、原RGB ROI SHA、返回四点框和置信度，超时/异常/重复请求有界终止。

`perception/ocr_worker.py --image-root <项目图像目录> [--model-manifest <项目本地manifest>]`。未提供manifest明确unsupported；RapidOCR依赖与版本不匹配也unsupported。仅允许项目venv，候选RapidOCR3.9.x与PP-OCRv5/v6，依赖清单在perception/requirements-ocr.txt。本轮没有安装推理依赖或下载权重，没有OCR真实字体准确率结果。

manifest字段：version=1、kind=local-ocr-model、id、engine=rapidocr、精确engine_version=3.9.x、architecture=PP-OCRv5或PP-OCRv6、models=[{role:det|rec|cls,path,sha256}]。det/rec必需、cls可选；文件位于manifest下且SHA匹配。worker禁止网络，模型配置不能触发自动下载。不读取账户凭据。

`adoptOcr(result,request,original,current,fieldBindings,now,maxAgeMs)`只采纳白名单文字字段为local_ocr，保留原观察时间。换profile/layout、hash/ROI变动、遮挡、迟到拒绝。角色名字仍只是文字，不变成实体身份；模型文本不能产生ready/dead/位置等CV权威字段。

`RegionalSeedRouter.plan(profile,observation,source,ambiguities,now,prompt)`只生成批准可见ROI的crop请求规划、来源映射、次数/像素预算和内容去重；本轮没有读key或调用API。像素预算不是token估计。

`perception/region_image.py <绝对JPEG输出> < crop-plan.json`验证无损母PNG SHA，再实际裁切/缩放/编码JPEG，输出新的文件SHA与原图坐标缩放映射。不能给PNG换后缀骗JPEG worker。

## 冻结与测试

`freezeRegionProfile(profilePath,destination,contextPath)`复制profile/context与全部PNG模板，并返回{id,files,profilePath,contextPath}。EyeRunStore.create接受regionProfilePath/regionContextPath；manifest.regional_profile保存SHA。新native schema需要regional schema时自动冻结权威依赖；replay只读冻结副本并核对profile/context/assets SHA及原生批次的profile来源，不回读运行外资源。

可运行入口：

```sh
bash tools/region_fixture_build.sh
agent/node_modules/.bin/tsx --test agent/tests/regional-eye.test.ts
agent/node_modules/.bin/tsc --noEmit --project agent/tsconfig.json
```

fixture实际运行Windows System.Drawing原Bitmap：同帧多区、0.5填充比例、模板label、锚点隐藏、遮挡、build/DPI失效、缓存原时间与关键字段逐帧重解析。TS还覆盖孤儿/篡改缓存、冻结、OCR常驻unsupported/假worker/迟到/权限边界、Seed预算、同名tracks及对话元素。假worker只证明传输/采纳，不能当OCR精度。

真实缺口：当前正式服HUD/弹窗profile与独立遮挡语料、游戏字体OCR权重/准确率/延迟、区域Seed真实用量对照、20Hz吞吐/高DPI布局变化、世界姓名板/危险地面和导航定位尚未验收。未把这些缺口填成known。

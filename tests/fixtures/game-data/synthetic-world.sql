-- SYNTHETIC TEST DATA. This file is never submitted to an SQL engine.
CREATE TABLE `quest_template` (
  `ID` int unsigned,
  `ContentTuningID` int,
  `AllowableRaces` bigint unsigned,
  `LogTitle` text,
  `VerifiedBuild` int
);
INSERT INTO `quest_template` VALUES (1,5,12261800583900083122,'Fixture Mission A',12345),(2,5,18446744073709551615,'Fixture Mission B',12345),(3,5,18446744073709551615,'Fixture Mission C',12345);
CREATE TABLE `quest_template_locale` (
  `ID` int,
  `locale` varchar(4),
  `LogTitle` text,
  `VerifiedBuild` int
);
INSERT INTO `quest_template_locale` VALUES (1,'zhCN','合成任务一',23456),(2,'zhCN','合成任务二',23456),(3,'zhCN','合成任务三',23456);
CREATE TABLE `quest_template_addon` (
  `ID` int,
  `PrevQuestID` int,
  `ExclusiveGroup` int
);
CREATE TABLE `quest_objectives` (
  `ID` int,
  `QuestID` int,
  `Type` int,
  `Order` int,
  `StorageIndex` int,
  `ObjectID` int,
  `Amount` int,
  `Flags` int,
  `Flags2` int,
  `ParentObjectiveID` int,
  `Description` text,
  `VerifiedBuild` int
);
INSERT INTO `quest_objectives` VALUES (50,1,0,0,0,900,1,0,0,0,'Rescue the fixture; do not infer a kill',12345),(51,2,1,1,2,901,2,28,1,50,'Optional hidden fixture',12345);
CREATE TABLE `creature_queststarter` (
  `id` int,
  `quest` int,
  `VerifiedBuild` int
);
CREATE TABLE `creature_questender` (
  `id` int,
  `quest` int,
  `VerifiedBuild` int
);
CREATE TABLE `gameobject_queststarter` (
  `id` int,
  `quest` int,
  `VerifiedBuild` int
);
CREATE TABLE `gameobject_questender` (
  `id` int,
  `quest` int,
  `VerifiedBuild` int
);
CREATE TABLE `quest_poi` (
  `QuestID` int,
  `BlobIndex` int,
  `Idx1` int,
  `MapID` int,
  `UiMapID` int,
  `VerifiedBuild` int
);
INSERT INTO `quest_poi` VALUES (1,0,0,2444,2022,12345);
CREATE TABLE `quest_poi_points` (
  `QuestID` int,
  `Idx1` int,
  `Idx2` int,
  `X` int,
  `Y` int,
  `Z` int,
  `VerifiedBuild` int
);
INSERT INTO `quest_poi_points` VALUES (1,0,0,-3000,4000,5,12345);
CREATE TABLE `conditions` (
  `SourceEntry` int,
  `ConditionValue1` int,
  `ElseGroup` int,
  `NegativeCondition` int
);
CREATE TABLE `creature_template` (
  `entry` int,
  `name` text,
  `npcflag` bigint unsigned,
  `VerifiedBuild` int
);
INSERT INTO `creature_template` VALUES (900,'Synthetic Credit',9223372036854775808,12345);
CREATE TABLE `creature_template_locale` (
  `entry` int,
  `locale` varchar(4),
  `Name` text,
  `VerifiedBuild` int
);
INSERT INTO `creature_template_locale` VALUES (900,'zhCN','合成目标怪',23456);
CREATE TABLE `creature` (
  `guid` int,
  `id` int,
  `map` int,
  `VerifiedBuild` int
);
CREATE TABLE `gameobject_template` (
  `entry` int,
  `name` text,
  `VerifiedBuild` int
);
CREATE TABLE `gameobject` (
  `guid` int,
  `id` int,
  `map` int,
  `VerifiedBuild` int
);
CREATE TABLE `quest_objectives_locale` (
  `ID` int,
  `locale` varchar(4),
  `Description` text,
  `VerifiedBuild` int
);

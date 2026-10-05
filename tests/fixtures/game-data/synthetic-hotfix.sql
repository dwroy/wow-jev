-- SYNTHETIC TEST DATA. No client extraction or downloaded map evidence.
CREATE TABLE `ui_map` (
  `Name` text,
  `ID` int,
  `ParentUiMapID` int,
  `VerifiedBuild` int
);
INSERT INTO `ui_map` VALUES ('Synthetic, region',2022,1978,12345);
CREATE TABLE `ui_map_assignment` (
  `ID` int,
  `UiMapID` int,
  `MapID` int,
  `VerifiedBuild` int
);
CREATE TABLE `content_tuning` (
  `ID` int,
  `MinLevel` int,
  `MaxLevel` int,
  `VerifiedBuild` int
);

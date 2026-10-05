export type GameBranch = "retail" | "classic-era" | "classic-progression" | "classic-seasonal" | "classic-anniversary" | "custom" | "unknown";
export type EntityKind = "creature" | "quest" | "item" | "spell" | "zone";
export interface GameVersion {
  branch: GameBranch;
  expansion: string | null;
  patch: string | null;
  build: number | null;
  region: "cn" | "us" | "eu" | "kr" | "tw" | null;
  locale: string | null;
}
export interface GameDataProof {
  version: GameVersion;
  method: "source_exact_build" | "local_observation" | "client_extract";
  evidence_url: string;
  verified_at: string;
  evidence_sha256: string;
}
export interface GameDataAssertion {
  assertion_sha256: string;
  reference_only: boolean;
  kind: EntityKind;
  entity_id: number;
  name: string;
  facts: Record<string, unknown>;
  source: {
    provider: string;
    url: string;
    retrieved_at: string;
    evidence_kind: "external_reference" | "external_comment" | "blizzard_api" | "local_observation" | "client_extract";
    source_version: GameVersion;
    artifact_sha256: string | null;
    locator: string;
    note: string;
  };
  applicability: GameDataProof[];
}
export interface GameDataResult {
  schema_version: 1;
  status: "found" | "not_found" | "version_unknown" | "ambiguous" | "conflict" | "references";
  requested_version: GameVersion | null;
  records: GameDataAssertion[];
  automatic_action_eligible: false;
  applicable_to_requested_client?: false;
}
export interface GameDataStats {
  schema_version: 1;
  assertions: number;
  reference_only: number;
  applicable_assertions: number;
  versions: number;
  imports: number;
  client_profiles: number;
}
export type EntitySelector = { kind: EntityKind; entity_id: number; name?: never } | { kind: EntityKind; name: string; entity_id?: never };

-- SYNTHETIC TEST DATA. No downloaded source, game observation or actual quest evidence.
root(ROOTS.Zones, m(DRAGON_ISLES, bubbleDown({ ["timeline"] = { ADDED_FIXTURE } }, {
    m(THE_WAKING_SHORES, {
        q(1, { -- Fixture Mission A [A]
            ["sourceQuests"] = { 10 },
            ["races"] = ALLIANCE_ONLY,
            ["provider"] = { "n", 900 },
            ["coord"] = { 10.0, 20.0, THE_WAKING_SHORES },
        }),
        q(2, { -- Fixture Mission B [H]
            ["sourceQuests"] = { 11 },
            ["races"] = HORDE_ONLY,
            ["provider"] = { "i", 901 },
            ["coord"] = { 11.0, 21.0, THE_WAKING_SHORES },
        }),
        q(3, { -- Fixture Mission C
            ["sourceQuests"] = { 1, 2 },
            ["sqreq"] = 1,
            ["provider"] = { "o", 902 },
            ["coord"] = { 12.0, 22.0, THE_WAKING_SHORES },
            ["groups"] = {
                o(903, {
                    ["coord"] = { 13.0, 23.0, THE_WAKING_SHORES },
                    ["groups"] = { i(904) },
                }),
            },
        }),
        q(10, { -- Fixture Historical Breadcrumb
            ["timeline"] = { ADDED_FIXTURE, REMOVED_FIXTURE },
            ["isBreadcrumb"] = true,
            ["races"] = ALLIANCE_ONLY,
        }),
    }),
})));

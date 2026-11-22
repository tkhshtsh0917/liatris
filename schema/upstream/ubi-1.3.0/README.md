# UBI 1.3.0 schemas

These files are unchanged copies from [o19s/ubi at `1ae5c42`](https://github.com/o19s/ubi/tree/1ae5c42ba14e30ab5faae5c48b7777d686409ee1/schema/1.3.0), licensed under [Apache-2.0](LICENSE).

| File | SHA-256 |
| --- | --- |
| `event.schema.json` | `047322dea1dad6a24702587476046e1441037f43b4bb64d2bf64e6147496dd21` |
| `query.request.schema.json` | `788725ddf1803df12c238e28e4734599e1b2d24e54f2404c1a90bd4afbd85cf7` |
| `query.response.schema.json` | `1ced24082254d06bc32aea538a91e3200793f2ff343abc9b2b7899025338c7d8` |

Liatris applies two explicit changes in memory when a profile selects `compat`. Each change replaces an overlapping `oneOf` with its unrestricted string branch, retaining the 100-character limit. The affected properties are `action_name` and `event_attributes.object.object_id_type`. `strict` validates against the unchanged schemas. The compatibility mode leaves `position` and its mutually exclusive options intact.

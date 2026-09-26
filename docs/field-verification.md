# SGSITS outdoor route field verification

The importer deliberately keeps every row below out of the routing graph. Do not approve from aerial imagery alone. Walk the complete geometry shown by the OSM way link and record one decision:

**Deployment status:** deferred by the project owner. All `UNVERIFIED` rows remain unapproved, are excluded from public A*, and produce an honest “No verified route available” state until a later on-site survey.

- `main`: continuous ordinary outdoor walking surface, including wheelchair use for this prototype.
- `shortcut`: physically walkable unofficial shortcut; excluded from wheelchair routing.
- `needs_edit`: only part is walkable, geometry crosses a building/wall, endpoint is wrong, or a missing junction must be drawn explicitly.
- `reject`: not a campus walking route.

For `main` or `shortcut`, also confirm there is no locked gate, wall, building crossing, unrepresented level crossing, or inaccessible gap. A visual crossing is not a junction unless the paths physically meet at the same level.

| OSM way                                                    | OSM classification                     | Start `[lon, lat]`         | End `[lon, lat]`           | Field decision                                               |
| ---------------------------------------------------------- | -------------------------------------- | -------------------------- | -------------------------- | ------------------------------------------------------------ |
| [202920180](https://www.openstreetmap.org/way/202920180)   | private service                        | `[75.8728246, 22.7247319]` | `[75.8728725, 22.7255981]` | `UNVERIFIED`                                                 |
| [202920181](https://www.openstreetmap.org/way/202920181)   | private service                        | `[75.8738303, 22.7273593]` | `[75.8733314, 22.7273714]` | `UNVERIFIED`                                                 |
| [202920183](https://www.openstreetmap.org/way/202920183)   | private service                        | `[75.8729746, 22.7263964]` | `[75.8730185, 22.7271623]` | `UNVERIFIED`                                                 |
| [202920184](https://www.openstreetmap.org/way/202920184)   | private service                        | `[75.8737494, 22.7263419]` | `[75.8743249, 22.7273295]` | `UNVERIFIED`                                                 |
| [202920185](https://www.openstreetmap.org/way/202920185)   | private service                        | `[75.8700046, 22.7258188]` | `[75.8699723, 22.7257137]` | `UNVERIFIED`                                                 |
| [202920186](https://www.openstreetmap.org/way/202920186)   | private service                        | `[75.8728725, 22.7255981]` | `[75.8735975, 22.7255913]` | `UNVERIFIED`                                                 |
| [202920187](https://www.openstreetmap.org/way/202920187)   | private service                        | `[75.8729509, 22.7260854]` | `[75.8730534, 22.7276620]` | `UNVERIFIED`                                                 |
| [202920188](https://www.openstreetmap.org/way/202920188)   | private service                        | `[75.8728725, 22.7255981]` | `[75.8742620, 22.7263026]` | `UNVERIFIED`                                                 |
| [202920189](https://www.openstreetmap.org/way/202920189)   | private service                        | `[75.8699296, 22.7248628]` | `[75.8728725, 22.7255981]` | `UNVERIFIED`                                                 |
| [202920190](https://www.openstreetmap.org/way/202920190)   | private service                        | `[75.8735975, 22.7255913]` | `[75.8699584, 22.7251216]` | `UNVERIFIED`                                                 |
| [320181214](https://www.openstreetmap.org/way/320181214)   | private service                        | `[75.8730185, 22.7271623]` | `[75.8730534, 22.7276620]` | `UNVERIFIED`                                                 |
| [1264750241](https://www.openstreetmap.org/way/1264750241) | private service                        | `[75.8723334, 22.7260997]` | `[75.8700046, 22.7258188]` | `UNVERIFIED`                                                 |
| [995119335](https://www.openstreetmap.org/way/995119335)   | Race Course Road, tertiary carriageway | `[75.8690247, 22.7248561]` | `[75.8740818, 22.7246865]` | `reject` unless a separate safe walking geometry is surveyed |
| [995119337](https://www.openstreetmap.org/way/995119337)   | Race Course Road, tertiary carriageway | `[75.8740943, 22.7246153]` | `[75.8690188, 22.7247512]` | `reject` unless a separate safe walking geometry is surveyed |
| [1264482101](https://www.openstreetmap.org/way/1264482101) | tertiary road link                     | `[75.8737987, 22.7246908]` | `[75.8741478, 22.7248374]` | `reject` unless a separate safe walking geometry is surveyed |

## Missing paths

During the same walk, note any major pedestrian path absent from the table, including both endpoint coordinates and every turn. Record whether it is an ordinary main path or an unofficial shortcut, and which existing verified path/node it physically meets. Do not infer a connection merely from close map geometry.

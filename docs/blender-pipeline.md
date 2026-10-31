# Blender to Unreal

Getting a mesh from Blender into Unreal and knowing that it arrived right. The pipeline has two halves:

1. **Export, in Blender.** [MifBlender](https://github.com/HustlerZ90210/MifBlender) writes the FBX. According to its
   source it already covers the Unreal conventions: `export_mesh` writes a centimeter, Z-up FBX with the
   exporter settings pinned; `create_collision_hull` makes `UCX_` hulls; `build_lod_chain` names LODs
   `<object>_LOD1`, `<object>_LOD2` ... under a `<object>_LODGroup`; `build_kit_piece` puts the lightmap UV
   layer last; `uv_info` and `mesh_quality` check the mesh. Nothing here duplicates that.
2. **Import and check, in Unreal.** The tools below, in the `mesh` module.

| Tool | What it does |
|---|---|
| `import_fbx` | Imports an FBX as a static mesh, skeletal mesh or animation with the import options that matter. A static mesh comes back with the same report as `inspect_static_mesh` |
| `inspect_static_mesh` | Reads back what a static mesh is: size in cm, vertices and triangles per LOD, UV channels, material slots, collision, lightmap settings, Nanite, plus warnings |
| `set_lightmap_settings` | Sets the UV channel used for lightmaps (a named one, or the last) and the lightmap resolution |

A round trip, as an assistant would run it:

1. In Blender (MifBlender): build or fix the mesh, `export_mesh` to a `.fbx`.
2. `import_fbx` with the file, a folder under your own mod folder, and what you know about it:
   `generate_lightmap_uvs: false` when the file carries an authored lightmap layer, `expected_max_dimension_cm`
   with the size you modelled.
3. Read the `meshes[0].warnings` it returns. Fix what they say - in Blender and re-import with
   `replace_existing: true`, or here with `set_lightmap_settings`.

## import_fbx

Only the options you pass are changed; everything else keeps Unreal's default.

| Option | Applies to | Sets |
|---|---|---|
| `kind` | all | `static_mesh` (default), `skeletal_mesh` or `animation`. An animation needs `skeleton_path` |
| `name`, `replace_existing`, `save` | all | Asset name, overwrite an asset of that name (off by default), save the result |
| `import_materials`, `import_textures` | all | Create materials / import textures |
| `convert_scene_unit`, `import_uniform_scale` | all | Unit conversion and a fixed scale factor |
| `normals` | static, skeletal | `compute`, `import`, `import_with_tangents` |
| `combine_meshes`, `auto_generate_collision`, `one_convex_hull_per_ucx`, `generate_lightmap_uvs`, `import_mesh_lods`, `build_nanite`, `remove_degenerates`, `vertex_colors` | static | The matching static mesh import options |
| `skeleton_path`, `create_physics_asset`, `import_animations` | skeletal / animation | The skeleton to use, a physics asset, animations in the mesh file |

The destination folder is checked by the [content protection](ron.md#content-protection): importing into
folders that hold game content is refused.

## What inspect_static_mesh warns about

| Warning | Cause it points to |
|---|---|
| No simple collision | The file had no `UCX_` hulls (or they were not imported) and nothing was generated |
| Lightmap Coordinate Index outside the UV channels | The index points past the last channel |
| Lightmaps use UV channel 0, the only channel | No second UV set; fine only if channel 0 has no overlaps or tiling |
| Lightmap Coordinate Index is 0 but there are several channels | An authored lightmap UV is usually the last one: `set_lightmap_settings` with `use_last_uv_channel` |
| Over 500 m / under 1 cm across | Meters imported as centimeters, or the other way round |
| Largest dimension differs from `expected_max_dimension_cm` | A wrong scale; a factor near 100 is meters against centimeters |
| N triangles with a single LOD | A dense mesh without LODs |

## What has and has not been checked

- Every Unreal API name and enum these tools use is checked against the UE 5.3 Python API
  (`npm run check:ue-api`). That check found two mistakes while the tools were written.
- The report and the warnings run for real in the tests, against a fake `unreal` module that says what the
  mesh is: sizes, channels, collision, LODs, the lightmap-index rules.
- **Not checked:** an import in a real UE 5.3.2 editor, and a real FBX from MifBlender. The option names are
  right for 5.3; whether a given combination behaves as you expect with your file is for you to see in the
  report. MifBlender was read, not run.

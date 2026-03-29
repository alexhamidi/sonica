CREATE TABLE IF NOT EXISTS user_track_projections (
    user_id  uuid NOT NULL,
    track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    umap_x   real,
    umap_y   real,
    pca_x    real,
    pca_y    real,
    tsne_x   real,
    tsne_y   real,
    PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS user_track_projections_user_id_idx
    ON user_track_projections (user_id);

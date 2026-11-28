<?php
/**
 * Captures Playground's baseline state before Blueprint steps execute so Stage 2 materialized
 * export only extracts files, content, and options created or modified by the Blueprint.
 */

if ( ! defined( 'ABSPATH' ) && file_exists( '/wordpress/wp-load.php' ) ) {
    require_once '/wordpress/wp-load.php';
}

$mounted_prefixes = isset( $wpai_mounted_prefixes ) && is_array( $wpai_mounted_prefixes )
    ? $wpai_mounted_prefixes
    : array();
$snapshot_path = isset( $wpai_presnapshot_path ) && is_string( $wpai_presnapshot_path )
    ? $wpai_presnapshot_path
    : '/wpai-out/pre-snapshot.json';

$is_mounted = static function ( string $rel ) use ( $mounted_prefixes ): bool {
    foreach ( $mounted_prefixes as $prefix ) {
        if ( $rel === $prefix || str_starts_with( $rel, $prefix . '/' ) ) {
            return true;
        }
    }
    return false;
};

$files = array();
$wp_content_root = '/wordpress/wp-content';

$walk = static function ( string $dir, string $rel_dir ) use ( &$walk, &$files, $is_mounted ): void {
    $entries = @scandir( $dir );
    if ( ! is_array( $entries ) ) {
        return;
    }
    foreach ( $entries as $entry ) {
        if ( $entry === '.' || $entry === '..' ) {
            continue;
        }
        $rel = $rel_dir === '' ? $entry : ( $rel_dir . '/' . $entry );
        if ( $rel === 'database' || str_starts_with( $rel, 'database/' ) || $rel === 'db.php' ) {
            continue;
        }
        if ( $is_mounted( $rel ) ) {
            continue;
        }
        $full = $dir . '/' . $entry;
        if ( is_link( $full ) ) {
            continue;
        }
        if ( is_dir( $full ) ) {
            $walk( $full, $rel );
        } elseif ( is_file( $full ) ) {
            $hash = @hash_file( 'sha256', $full );
            if ( is_string( $hash ) ) {
                $files[ $rel ] = $hash;
            }
        }
    }
};

if ( is_dir( $wp_content_root ) ) {
    $walk( $wp_content_root, '' );
}

$posts = array();
$initial_posts = get_posts( array(
    'post_type'   => 'any',
    'post_status' => 'any',
    'numberposts' => -1,
) );
foreach ( $initial_posts as $p ) {
    $posts[ (string) $p->ID ] = array(
        'slug' => (string) $p->post_name,
        'type' => (string) $p->post_type,
        'hash' => sha1(
            (string) $p->post_type . '|' .
            (string) $p->post_status . '|' .
            (string) $p->post_name . '|' .
            (string) $p->post_title . '|' .
            (string) $p->post_content
        ),
    );
}

$tracked_options = array(
    'posts_per_page',
    'timezone_string',
    'date_format',
    'time_format',
    'start_of_week',
);
$options = array();
foreach ( $tracked_options as $opt_name ) {
    $options[ $opt_name ] = get_option( $opt_name, null );
}

$theme = wp_get_theme();
$snapshot = array(
    'files'             => $files,
    'posts'             => $posts,
    'options'           => $options,
    'active_stylesheet' => (string) $theme->get_stylesheet(),
);

file_put_contents( $snapshot_path, json_encode( $snapshot, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );

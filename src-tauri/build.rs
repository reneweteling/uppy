fn main() {
    // Check for required AWS environment variables during build
    let required_env_vars = [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY", 
        "AWS_REGION",
        "AWS_BUCKET"
    ];

    for var in &required_env_vars {
        if std::env::var(var).is_err() {
            panic!("Required environment variable {} is not set. Please set it before building.", var);
        }
    }

    println!("cargo:rustc-env=AWS_ACCESS_KEY_ID={}", std::env::var("AWS_ACCESS_KEY_ID").unwrap());
    println!("cargo:rustc-env=AWS_REGION={}", std::env::var("AWS_REGION").unwrap());
    println!("cargo:rustc-env=AWS_BUCKET={}", std::env::var("AWS_BUCKET").unwrap());

    tauri_build::build()
}

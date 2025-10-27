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
        println!("cargo:rustc-env={}={}", var, std::env::var(var).unwrap());
    }

    tauri_build::build()
}
